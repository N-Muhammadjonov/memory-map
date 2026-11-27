// Downloads work in a normal browser and in the origin-scoped native Android window.
const CHUNK_BYTES = 48 * 1024;
const MAX_NATIVE_BYTES = 1024 * 1024 * 1024;
let active = false;

function cleanName(name) {
  return String(name || "MemoryMap-download").replace(/[\\/\x00-\x1f\x7f]/g, "_").slice(0, 180) || "MemoryMap-download";
}

function exchange(bridge, message, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("The native save did not complete. Try again.")), timeout);
    function finish(error, value) {
      clearTimeout(timer);
      bridge.onmessage = null;
      error ? reject(error) : resolve(value);
    }
    bridge.onmessage = event => {
      try {
        const result = JSON.parse(event.data);
        if (result.id !== message.id) return;
        if (result.status === "error") finish(new Error(result.message || "Could not save the file."));
        else finish(null, result.status);
      } catch { finish(new Error("Invalid native download response.")); }
    };
    try { bridge.postMessage(JSON.stringify(message)); }
    catch (error) { finish(error); }
  });
}

async function saveNative(bridge, blob, name) {
  if (active) throw new Error("Finish the current file save first.");
  if (blob.size > MAX_NATIVE_BYTES) throw new Error("This file exceeds the 1 GiB native export limit.");
  active = true;
  const id = crypto.randomUUID();
  try {
    const mime = (blob.type || "application/octet-stream").split(";")[0];
    const start = await exchange(bridge, {id, action: "begin", name, mime, size: blob.size}, 300_000);
    if (start === "cancel") return false;
    if (start !== "ready") throw new Error("The native save could not start.");
    for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
      const bytes = new Uint8Array(await blob.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      if (await exchange(bridge, {id, action: "chunk", offset, data: btoa(binary)}, 60_000) !== "ack") {
        throw new Error("The native file save was interrupted.");
      }
    }
    if (await exchange(bridge, {id, action: "finish"}, 60_000) !== "saved") throw new Error("The native file save was interrupted.");
    return true;
  } catch (error) {
    try { bridge.postMessage(JSON.stringify({id, action: "abort"})); } catch {}
    throw error;
  } finally { active = false; }
}

export async function saveBlob(blob, filename) {
  const name = cleanName(filename);
  const bridge = globalThis.MemoryMapNativeDownloads;
  if (bridge && typeof bridge.postMessage === "function") return saveNative(bridge, blob, name);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

export function dataUrlBlob(value) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) throw new Error("Could not create the image download.");
  const bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0));
  return new Blob([bytes], {type: match[1]});
}
