"""Platform speech recognition. Audio is never sent to Memory map servers."""
from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from threading import RLock, Thread
from typing import Any

from vault import VaultError

LANGUAGES = {"en": "en-US", "uz": "uz-UZ", "ru": "ru-RU", "tr": "tr-TR", "es": "es-ES", "ar": "ar-SA"}


class VoiceService:
    """A bounded, explicit-start dictation session, isolated from note storage."""

    def __init__(self) -> None:
        self.lock = RLock()
        self.id = ""
        self.phase = "idle"
        self.message = ""
        self.text = ""
        self.partial = ""
        self.started = 0.0
        self.backend: Any = None
        self.model: Any = None
        self.locale = "en-US"

    @property
    def mode(self) -> str:
        return "pcm" if sys.platform.startswith("linux") and "ANDROID_ARGUMENT" not in os.environ else "native"

    def status(self, identifier: str) -> dict[str, Any]:
        with self.lock:
            if identifier != self.id:
                return {"phase": "idle", "text": "", "partial": "", "message": ""}
            if self.phase in ("starting", "listening") and time.monotonic() - self.started > 90:
                self.finish(identifier)
            return {"phase": self.phase, "text": self.text, "partial": self.partial, "message": self.message}

    def start(self, identifier: str, language: str) -> dict[str, Any]:
        if not isinstance(identifier, str) or len(identifier) != 36 or not isinstance(language, str) or language not in LANGUAGES:
            raise VaultError("Invalid voice session.")
        self.cancel()
        with self.lock:
            self.id, self.phase, self.message, self.text, self.partial = identifier, "starting", "", "", ""
            self.started = time.monotonic()
            self.locale = LANGUAGES[language]
        if sys.platform == "darwin":
            try:
                from PyObjCTools import AppHelper
                AppHelper.callAfter(self._mac_start, identifier)
            except ImportError:
                self.fail(identifier, "macOS speech components are missing. Install the official app.")
        elif sys.platform == "win32":
            Thread(target=self._windows_start, args=(identifier,), daemon=True).start()
        elif self.mode == "pcm":
            # The browser obtains explicit microphone permission before starting PCM capture.
            if language != "en":
                self.fail(identifier, "Offline Linux dictation currently supports English. Select English to dictate.")
        else:
            self.fail(identifier, "Use Android system voice recognition.")
        return {"mode": self.mode, **self.status(identifier)}

    def active(self, identifier: str) -> bool:
        with self.lock:
            return self.id == identifier and self.phase in ("starting", "listening")

    def update(self, identifier: str, *, partial: str = "", final: str = "", listening: bool = False) -> None:
        with self.lock:
            if not self.active(identifier):
                return
            if listening:
                self.phase = "listening"
            if final:
                self.text = (self.text + " " + final.strip()).strip()[:32000]
            self.partial = partial[:32000]

    def fail(self, identifier: str, message: str) -> None:
        with self.lock:
            if not self.active(identifier):
                return
            self.phase, self.message = "error", message
            self._dispose()

    def finish(self, identifier: str) -> None:
        with self.lock:
            if not self.active(identifier):
                return
            if self.mode == "pcm" and self.backend:
                try:
                    final = json.loads(self.backend.FinalResult()).get("text", "")
                    self.text = (self.text + " " + final).strip()
                    self.partial = ""
                except (ValueError, RuntimeError):
                    pass
            if self.partial:
                self.text = (self.text + " " + self.partial).strip()[:32000]
                self.partial = ""
            self.phase = "done"
            self._dispose()

    def _dispose(self) -> None:
        backend, self.backend = self.backend, None
        if not backend:
            return
        if sys.platform == "darwin":
            from PyObjCTools import AppHelper
            AppHelper.callAfter(backend.close)
        elif sys.platform == "win32":
            try:
                backend.terminate()
            except OSError:
                pass

    def cancel(self) -> None:
        with self.lock:
            self.phase = "idle"
            self.id = ""
            self.text = self.partial = ""
            self._dispose()

    def pcm(self, identifier: str, encoded: str, rate: int) -> dict[str, Any]:
        with self.lock:
            if self.mode != "pcm" or not self.active(identifier):
                raise VaultError("No active microphone session.", 409)
            if type(rate) is not int or not 8000 <= rate <= 96000 or not isinstance(encoded, str) or len(encoded) > 65536:
                raise VaultError("Invalid audio chunk.")
            try:
                audio = base64.b64decode(encoded, validate=True)
                if not audio or len(audio) % 2:
                    raise ValueError()
                if not self.backend:
                    import vosk
                    model_path = Path(getattr(sys, "_MEIPASS", Path(__file__).parent)) / "models" / "voice-en"
                    if not model_path.is_dir():
                        self.fail(identifier, "The offline speech model is missing. Install the official Linux build.")
                        return self.status(identifier)
                    if self.model is None:
                        self.model = vosk.Model(str(model_path))
                    self.backend = vosk.KaldiRecognizer(self.model, rate)
                if self.backend.AcceptWaveform(audio):
                    recognized = json.loads(self.backend.Result()).get("text", "")
                    self.update(identifier, final=recognized, listening=True)
                    if recognized:
                        self.finish(identifier)
                else:
                    self.update(identifier, partial=json.loads(self.backend.PartialResult()).get("partial", ""), listening=True)
            except (ValueError, ImportError, RuntimeError):
                self.fail(identifier, "Offline speech recognition could not start. Check the microphone and speech model.")
            return self.status(identifier)

    def _mac_start(self, identifier: str) -> None:
        if not self.active(identifier):
            return
        try:
            from AVFoundation import AVCaptureDevice, AVMediaTypeAudio
            from Speech import SFSpeechRecognizer
            from PyObjCTools import AppHelper

            def microphone(granted: bool) -> None:
                if not granted:
                    self.fail(identifier, "Microphone access was denied. Allow Memory map in System Settings → Privacy & Security → Microphone.")
                    return
                if self.active(identifier):
                    SFSpeechRecognizer.requestAuthorization_(lambda authorization: AppHelper.callAfter(ready, authorization))

            def ready(authorization: int) -> None:
                if not self.active(identifier):
                    return
                if authorization != 3:
                    self.fail(identifier, "Speech Recognition access was denied. Allow Memory map in System Settings → Privacy & Security → Speech Recognition.")
                    return
                try:
                    with self.lock:
                        if not self.active(identifier):
                            return
                        self.backend = MacSpeech(self, identifier, self.locale)
                        self.backend.open()
                except Exception:
                    self.fail(identifier, "Speech recognition could not start. Check that the microphone and selected language are available.")

            AVCaptureDevice.requestAccessForMediaType_completionHandler_(AVMediaTypeAudio, lambda granted: AppHelper.callAfter(microphone, granted))
        except Exception:
            self.fail(identifier, "The macOS microphone or speech recognition service is unavailable.")

    def _windows_start(self, identifier: str) -> None:
        script = r"""
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Speech
    $culture = [System.Globalization.CultureInfo]::GetCultureInfo($env:MEMORY_MAP_SPEECH_LANGUAGE)
    $engine = [System.Speech.Recognition.SpeechRecognitionEngine]::new($culture)
    $engine.LoadGrammar([System.Speech.Recognition.DictationGrammar]::new())
    $engine.SetInputToDefaultAudioDevice()
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Write-Output '{"event":"listening"}'
    while ($true) {
        $result = $engine.Recognize([TimeSpan]::FromSeconds(5))
        if ($result -and $result.Text) {
            @{event='text'; text=$result.Text} | ConvertTo-Json -Compress
        }
    }
} catch {
    Write-Output '{"event":"error"}'
    exit 1
}
"""
        try:
            with self.lock:
                if not self.active(identifier):
                    return
                env = {**os.environ, "MEMORY_MAP_SPEECH_LANGUAGE": self.locale}
                executable = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
                process = subprocess.Popen([str(executable), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
                                           env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                           text=True, encoding="utf-8", errors="replace", creationflags=subprocess.CREATE_NO_WINDOW)
                self.backend = process
            for line in process.stdout or []:
                if not self.active(identifier):
                    break
                try:
                    data = json.loads(line)
                except ValueError:
                    continue
                if data.get("event") == "listening":
                    self.update(identifier, listening=True)
                elif data.get("event") == "text":
                    self.update(identifier, final=str(data.get("text", "")), listening=True)
                    self.finish(identifier)
                    break
                elif data.get("event") == "error":
                    break
            if self.active(identifier):
                self.fail(identifier, "Windows speech recognition could not open. Enable microphone access and install speech recognition for the selected language.")
            process.wait(timeout=5)
        except (OSError, subprocess.SubprocessError):
            self.fail(identifier, "Windows speech recognition is unavailable.")


class MacSpeech:
    def __init__(self, service: VoiceService, identifier: str, locale: str) -> None:
        from AVFoundation import AVAudioEngine
        from Foundation import NSLocale
        from Speech import SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognizer
        self.service, self.identifier = service, identifier
        self.recognizer = SFSpeechRecognizer.alloc().initWithLocale_(NSLocale.localeWithLocaleIdentifier_(locale))
        self.request = SFSpeechAudioBufferRecognitionRequest.alloc().init()
        self.request.setShouldReportPartialResults_(True)
        if self.recognizer and self.recognizer.supportsOnDeviceRecognition():
            self.request.setRequiresOnDeviceRecognition_(True)
        self.engine = AVAudioEngine.alloc().init()
        self.node = self.engine.inputNode()
        self.task = None
        self.tapped = False

    def open(self) -> None:
        if not self.recognizer or not self.recognizer.isAvailable():
            raise RuntimeError("Speech recognizer unavailable")
        audio_format = self.node.outputFormatForBus_(0)
        if not audio_format.channelCount() or not audio_format.sampleRate():
            raise RuntimeError("Microphone unavailable")
        self.node.installTapOnBus_bufferSize_format_block_(0, 1024, audio_format, lambda buffer, _time: self.request.appendAudioPCMBuffer_(buffer))
        self.tapped = True
        self.task = self.recognizer.recognitionTaskWithRequest_resultHandler_(self.request, self._result)
        self.engine.prepare()
        started, _error = self.engine.startAndReturnError_(None)
        if not started:
            raise RuntimeError("Audio engine unavailable")
        self.service.update(self.identifier, listening=True)

    def _result(self, result: Any, error: Any) -> None:
        if result:
            text = str(result.bestTranscription().formattedString())
            if result.isFinal():
                self.service.update(self.identifier, final=text)
                self.service.finish(self.identifier)
            else:
                self.service.update(self.identifier, partial=text, listening=True)
        elif error:
            self.service.fail(self.identifier, "Speech recognition stopped. Check your microphone, language and speech service connection.")

    def close(self) -> None:
        self.engine.stop()
        if self.tapped:
            self.node.removeTapOnBus_(0)
            self.tapped = False
        self.request.endAudio()
        if self.task:
            self.task.cancel()
