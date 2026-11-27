package com.memorymap.app;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import android.content.Context;
import android.content.Intent;
import android.app.Instrumentation;
import android.webkit.WebView;
import android.os.SystemClock;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class WorkspaceTest {
    private static String request(String origin, String token, String path, String body) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(origin + path).openConnection();
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(15000);
        conn.setRequestProperty("Authorization", "Bearer " + token);
        if (body != null) {
            conn.setRequestProperty("Origin", origin);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            try (java.io.OutputStream out = conn.getOutputStream()) {
                out.write(body.getBytes(StandardCharsets.UTF_8));
            }
        }
        try {
            int expected = body != null && "/api/notes".equals(path) ? 201 : 200;
            int actual = conn.getResponseCode();
            if (actual != expected) {
                String detail = "";
                java.io.InputStream error = conn.getErrorStream();
                if (error != null) {
                    try (java.io.InputStream in = error;
                         java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream()) {
                        byte[] buf = new byte[512];
                        int n;
                        while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
                        detail = new String(out.toByteArray(), StandardCharsets.UTF_8);
                    }
                }
                fail(path + " returned " + actual + " — " + detail);
            }
            try (java.io.InputStream in = conn.getInputStream();
                 java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream()) {
                byte[] b = new byte[4096];
                int count;
                while ((count = in.read(b)) != -1) out.write(b,0,count);
                return new String(out.toByteArray(), StandardCharsets.UTF_8);
            }
        } finally { conn.disconnect(); }
    }

    @Test public void bundledWorkspaceCreatesAndUnlocksVault() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        if (!Python.isStarted()) Python.start(new AndroidPlatform(context));
        com.chaquo.python.PyObject entry = Python.getInstance().getModule("android_entry");
        File folder = new File(context.getCacheDir(), "workspace-test-" + System.nanoTime());
        assertTrue(folder.mkdirs());
        com.chaquo.python.PyObject directPath = Python.getInstance().getModule("pathlib")
            .callAttr("Path", new File(folder, "direct.xotira").getAbsolutePath());
        com.chaquo.python.PyObject directVault = Python.getInstance().getModule("vault")
            .callAttr("Vault", directPath);
        directVault.callAttr("unlock", "disposable-android-direct-password",
            new com.chaquo.python.Kwarg("create", true));
        directVault.callAttr("lock");
        String[] location = entry.callAttr("start", folder.getAbsolutePath()).toString().split("/#", 2);
        try {
            assertTrue(request(location[0],location[1],"/",null).contains("Memory map"));
            assertTrue(request(location[0],location[1],"/api/status",null).contains("false"));
            String body = "{\"password\":\"test-device-vault-password\",\"create\":true,\"confirmation\":\"test-device-vault-password\"}";
            assertTrue(request(location[0],location[1],"/api/create",body).contains("true"));
            assertTrue(request(location[0],location[1],"/api/status",null).contains("\"unlocked\": true"));
            String note = request(location[0],location[1],"/api/notes",
                "{\"notes\":[{\"title\":\"Emulator fixture\",\"body\":\"Encrypted mobile test\"}]}");
            String id = new org.json.JSONObject(note).getJSONArray("ids").getString(0);
            assertTrue(request(location[0],location[1],"/api/notes/"+id,null).contains("Encrypted mobile test"));
            request(location[0],location[1],"/api/lock","{}");
            assertTrue(request(location[0],location[1],"/api/unlock",body).contains("true"));
            assertTrue(request(location[0],location[1],"/api/notes/"+id,null).contains("Encrypted mobile test"));
        } finally { entry.callAttr("stop"); }
        verifyNativeWindow(context);
    }

    private static String evaluate(Instrumentation runner, WebView view, String script) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        runner.runOnMainSync(() -> view.evaluateJavascript(script, value -> {
            result.set(value);
            latch.countDown();
        }));
        assertTrue("WebView JavaScript callback did not complete", latch.await(10, TimeUnit.SECONDS));
        return result.get();
    }

    private static void waitFor(Instrumentation runner, WebView view, String condition) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 45_000;
        while (SystemClock.elapsedRealtime() < deadline) {
            if ("true".equals(evaluate(runner, view, condition))) return;
            SystemClock.sleep(250);
        }
        fail("Native WebView did not reach the expected state: " + condition);
    }

    private static void verifyNativeWindow(Context context) throws Exception {
        Instrumentation runner = InstrumentationRegistry.getInstrumentation();
        MainActivity activity = (MainActivity) runner.startActivitySync(new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            AtomicReference<WebView> viewRef = new AtomicReference<>();
            long deadline = SystemClock.elapsedRealtime() + 45_000;
            do {
                runner.runOnMainSync(() -> viewRef.set(activity.findViewById(R.id.workspace_webview)));
                if (viewRef.get() != null) break;
                SystemClock.sleep(200);
            } while (SystemClock.elapsedRealtime() < deadline);
            WebView view = viewRef.get();
            assertNotNull("The launcher must host a WebView, not open a browser activity", view);
            waitFor(runner, view, "Boolean(document.querySelector('#password:enabled'))");
            assertEquals("true", evaluate(runner, view, "location.origin.startsWith('http://127.0.0.1:')"));
            assertEquals("true", evaluate(runner, view, "typeof window.MemoryMapNativeDownloads?.postMessage === 'function'"));
            evaluate(runner, view, "document.getElementById('password').value='disposable-native-android-password';" +
                "document.getElementById('confirmation').value='disposable-native-android-password';" +
                "document.getElementById('unlock-button').click(); true");
            waitFor(runner, view, "Boolean(document.querySelector('#workspace:not([hidden])'))");
            evaluate(runner, view, "document.getElementById('create-note').click(); true");
            waitFor(runner, view, "Boolean(document.querySelector('#create-dialog[open]'))");
            evaluate(runner, view, "document.getElementById('new-title').value='Native Android window fixture';" +
                "document.getElementById('create-form').requestSubmit(); true");
            waitFor(runner, view, "!document.querySelector('#create-dialog[open]')");
            assertFalse("The native launcher must remain open", activity.isFinishing());
            String[] launch = VaultService.url.split("/#", 2);
            assertTrue(request(launch[0], launch[1], "/api/graph", null).contains("Native Android window fixture"));
        } finally {
            runner.runOnMainSync(activity::finish);
            context.stopService(new Intent(context, VaultService.class));
        }
    }
}
