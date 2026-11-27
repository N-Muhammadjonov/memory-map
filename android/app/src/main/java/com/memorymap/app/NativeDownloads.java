package com.memorymap.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import android.webkit.WebView;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import org.json.JSONObject;
import java.io.OutputStream;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Save a bounded stream in the user-selected document. No filesystem path or plaintext staging. */
final class NativeDownloads {
    static final int REQUEST = 9202;
    private static final long MAX_BYTES = 1024L * 1024 * 1024;
    private static final int MAX_CHUNK = 48 * 1024;
    private final Activity activity;
    private final String origin;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private Transfer active;
    private boolean destroyed;

    private static final class Transfer {
        final String id;
        final long size;
        final JavaScriptReplyProxy reply;
        long written;
        boolean busy;
        boolean ready;
        OutputStream output;  // accessed only on the single I/O executor

        Transfer(String id, long size, JavaScriptReplyProxy reply) {
            this.id = id;
            this.size = size;
            this.reply = reply;
        }
    }

    NativeDownloads(Activity activity, WebView webView, String origin) {
        this.activity = activity;
        this.origin = origin;
        WebViewCompat.addWebMessageListener(webView, "MemoryMapNativeDownloads",
            Collections.singleton(origin), this::onMessage);
    }

    private static void send(JavaScriptReplyProxy reply, String id, String status, String message) {
        try {
            JSONObject response = new JSONObject().put("id", id).put("status", status);
            if (message != null) response.put("message", message);
            reply.postMessage(response.toString());
        } catch (Exception ignored) { }
    }

    private void onMessage(WebView ignored, WebMessageCompat message, Uri sourceOrigin,
                           boolean mainFrame, JavaScriptReplyProxy reply) {
        if (destroyed || !mainFrame || sourceOrigin == null ||
            !Uri.parse(origin).getScheme().equals(sourceOrigin.getScheme()) ||
            !Uri.parse(origin).getHost().equals(sourceOrigin.getHost()) ||
            Uri.parse(origin).getPort() != sourceOrigin.getPort()) return;
        String id = "";
        try {
            String raw = message.getData();
            if (raw == null || raw.length() > 70_000) return;
            JSONObject data = new JSONObject(raw);
            id = data.getString("id");
            if (!id.matches("[a-f0-9-]{36}")) return;
            String action = data.getString("action");
            if ("begin".equals(action)) {
                begin(id, data, reply);
                return;
            }
            Transfer transfer = active;
            if (transfer == null || !id.equals(transfer.id)) {
                send(reply, id, "error", "No active file save.");
                return;
            }
            if ("abort".equals(action)) {
                clear(transfer);
                return;
            }
            if (transfer.busy || !transfer.ready) throw new IllegalStateException("Save not ready");
            if ("chunk".equals(action)) {
                long offset = data.getLong("offset");
                String encoded = data.getString("data");
                if (encoded.length() > MAX_CHUNK * 4 / 3 + 4) throw new IllegalArgumentException("Chunk too large");
                byte[] bytes = Base64.decode(encoded, Base64.NO_WRAP);
                if (offset != transfer.written || bytes.length == 0 || bytes.length > MAX_CHUNK ||
                    offset + bytes.length > transfer.size) throw new IllegalArgumentException("Invalid stream");
                transfer.busy = true;
                io.execute(() -> {
                    try {
                        transfer.output.write(bytes);
                        activity.runOnUiThread(() -> {
                            if (active != transfer) return;
                            transfer.written += bytes.length;
                            transfer.busy = false;
                            send(reply, transfer.id, "ack", null);
                        });
                    } catch (Exception error) { failFromWorker(transfer, "Could not write the selected file."); }
                });
            } else if ("finish".equals(action)) {
                if (transfer.written != transfer.size) throw new IllegalArgumentException("Incomplete file");
                transfer.busy = true;
                io.execute(() -> {
                    try {
                        transfer.output.close();
                        transfer.output = null;
                        activity.runOnUiThread(() -> {
                            if (active != transfer) return;
                            active = null;
                            send(reply, transfer.id, "saved", null);
                        });
                    } catch (Exception error) { failFromWorker(transfer, "Could not finish saving the file."); }
                });
            } else throw new IllegalArgumentException("Invalid save action");
        } catch (Exception error) {
            Transfer transfer = active;
            if (transfer != null && id.equals(transfer.id)) clear(transfer);
            send(reply, id, "error", "The native file save was interrupted. Try again.");
        }
    }

    private void begin(String id, JSONObject data, JavaScriptReplyProxy reply) throws Exception {
        if (active != null) {
            send(reply, id, "error", "Finish the current file save first.");
            return;
        }
        String name = data.getString("name");
        String mime = data.getString("mime");
        long size = data.getLong("size");
        if (name.isEmpty() || name.length() > 180 || name.contains("/") || name.contains("\\") ||
            name.matches(".*[\\p{Cntrl}].*") || ".".equals(name) || "..".equals(name) || size < 0 || size > MAX_BYTES) {
            throw new IllegalArgumentException("Invalid file");
        }
        if (!mime.matches("[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+")) mime = "application/octet-stream";
        active = new Transfer(id, size, reply);
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType(mime).putExtra(Intent.EXTRA_TITLE, name).addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        activity.startActivityForResult(intent, REQUEST);
    }

    void onResult(int result, Intent data) {
        Transfer transfer = active;
        if (transfer == null) return;
        Uri uri = result == Activity.RESULT_OK && data != null ? data.getData() : null;
        if (uri == null || !"content".equals(uri.getScheme())) {
            active = null;
            send(transfer.reply, transfer.id, "cancel", null);
            return;
        }
        transfer.busy = true;
        io.execute(() -> {
            try {
                transfer.output = activity.getContentResolver().openOutputStream(uri, "w");
                if (transfer.output == null) throw new IllegalStateException("No output stream");
                activity.runOnUiThread(() -> {
                    if (active != transfer) return;
                    transfer.busy = false;
                    transfer.ready = true;
                    send(transfer.reply, transfer.id, "ready", null);
                });
            } catch (Exception error) { failFromWorker(transfer, "Could not open the selected destination."); }
        });
    }

    private void failFromWorker(Transfer transfer, String message) {
        activity.runOnUiThread(() -> {
            if (active != transfer) return;
            clear(transfer);
            send(transfer.reply, transfer.id, "error", message);
        });
    }

    private void clear(Transfer transfer) {
        if (active == transfer) active = null;
        io.execute(() -> {
            try { if (transfer.output != null) transfer.output.close(); }
            catch (Exception ignored) { }
            transfer.output = null;
        });
    }

    void destroy() {
        destroyed = true;
        if (active != null) clear(active);
        io.shutdown();
    }
}
