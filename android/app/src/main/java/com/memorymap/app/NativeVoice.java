package com.memorymap.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.webkit.WebView;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Collections;

/** Explicit gesture, runtime microphone permission, main-frame loopback bridge. */
final class NativeVoice {
    static final int PERMISSION = 9203;
    private final Activity activity;
    private SpeechRecognizer recognizer;
    private JavaScriptReplyProxy reply;
    private String id = "", language = "en-US", partial = "";

    NativeVoice(Activity activity, WebView view, String origin) {
        this.activity = activity;
        WebViewCompat.addWebMessageListener(view, "MemoryMapNativeVoice", Collections.singleton(origin),
            (web, message, source, mainFrame, proxy) -> {
                if (!mainFrame || source == null || !Uri.parse(origin).getScheme().equals(source.getScheme()) ||
                    !Uri.parse(origin).getHost().equals(source.getHost()) || Uri.parse(origin).getPort() != source.getPort()) return;
                try {
                    String raw = message.getData();
                    if (raw == null || raw.length() > 512) return;
                    JSONObject data = new JSONObject(raw);
                    String requestedId = data.getString("id");
                    if (!requestedId.matches("[a-f0-9-]{36}")) return;
                    String action = data.getString("action");
                    if ("start".equals(action)) {
                        destroy();
                        id = requestedId;
                        reply = proxy;
                        language = data.optString("locale", "en-US");
                        if (!language.matches("(en-US|uz-UZ|ru-RU|tr-TR|es-ES|ar-SA)")) language = "en-US";
                        emit("starting", "", "");
                        if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
                            activity.requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, PERMISSION);
                        else start();
                    } else if (id.equals(requestedId)) {
                        if ("cancel".equals(action)) destroy();
                        else if ("finish".equals(action)) {
                            if (recognizer != null) recognizer.stopListening();
                            else { emit("done", partial, ""); destroy(); }
                        }
                    }
                } catch (Exception ignored) { }
            });
    }

    void permissionResult(boolean granted) {
        if (reply == null) return;
        if (granted) start();
        else { emit("error", "", "Microphone access denied. Allow Memory map in Android app permissions."); destroy(); }
    }

    private void emit(String phase, String text, String message) {
        if (reply == null) return;
        try {
            reply.postMessage(new JSONObject().put("id", id).put("phase", phase)
                .put("text", text).put("partial", partial).put("message", message).toString());
        } catch (Exception ignored) { }
    }

    private static String first(Bundle results) {
        ArrayList<String> values = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return values == null || values.isEmpty() ? "" : values.get(0);
    }

    private void start() {
        if (!SpeechRecognizer.isRecognitionAvailable(activity)) {
            emit("error", "", "No Android speech recognition service is installed. Enable your device speech service.");
            destroy();
            return;
        }
        try {
            recognizer = SpeechRecognizer.createSpeechRecognizer(activity);
            final String session = id;
            recognizer.setRecognitionListener(new RecognitionListener() {
                private boolean active() { return session.equals(id) && reply != null; }
                @Override public void onReadyForSpeech(Bundle params) { if (active()) emit("listening", "", ""); }
                @Override public void onBeginningOfSpeech() { if (active()) emit("listening", "", ""); }
                @Override public void onRmsChanged(float rms) { }
                @Override public void onBufferReceived(byte[] buffer) { }
                @Override public void onEndOfSpeech() { if (active()) emit("processing", "", ""); }
                @Override public void onError(int error) {
                    if (!active()) return;
                    if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                        emit("done", partial, partial.isEmpty() ? "No speech was recognized. Try again." : "");
                    } else {
                        emit("error", "", "Android speech recognition stopped (code " + error + "). Check microphone permission, language and speech service.");
                    }
                    destroy();
                }
                @Override public void onResults(Bundle results) {
                    if (!active()) return;
                    String text = first(results);
                    partial = "";
                    emit("done", text, "");
                    destroy();
                }
                @Override public void onPartialResults(Bundle results) {
                    if (active()) { partial = first(results); emit("listening", "", ""); }
                }
                @Override public void onEvent(int event, Bundle params) { }
            });
            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            recognizer.startListening(intent);
        } catch (Exception error) {
            emit("error", "", "Unable to start Android speech recognition.");
            destroy();
        }
    }

    void destroy() {
        reply = null;
        id = partial = "";
        if (recognizer != null) {
            recognizer.cancel();
            recognizer.destroy();
            recognizer = null;
        }
    }
}
