package com.memorymap.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.WindowInsets;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;
import androidx.webkit.WebViewFeature;

public final class MainActivity extends Activity {
    private static final int FILE_PICKER = 9201;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private TextView message;
    private WebView workspace;
    private String origin;
    private NativeDownloads downloads;
    private NativeVoice voice;
    private ValueCallback<Uri[]> fileCallback;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        root = new FrameLayout(this);
        message = new TextView(this);
        message.setGravity(Gravity.CENTER);
        message.setPadding(30, 30, 30, 30);
        message.setText("Opening your private Memory map workspace…");
        root.addView(message, new FrameLayout.LayoutParams(-1, -1));
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else {
                view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
        setContentView(root);
        Intent service = new Intent(this, VaultService.class);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(service);
        else startService(service);
        handler.post(this::openWhenReady);
    }

    private void openWhenReady() {
        if (isFinishing() || isDestroyed() || workspace != null) return;
        if (VaultService.failed) {
            message.setText("The local workspace could not start. Close Memory map and try again.");
            return;
        }
        String url = VaultService.url;
        if (url == null) {
            handler.postDelayed(this::openWhenReady, 200);
            return;
        }
        Uri address = Uri.parse(url);
        if (!"http".equals(address.getScheme()) || !"127.0.0.1".equals(address.getHost()) || address.getPort() <= 0 ||
            address.getUserInfo() != null || address.getFragment() == null || !address.getFragment().matches("[A-Za-z0-9_-]{43}")) {
            message.setText("The local workspace address is invalid.");
            return;
        }
        origin = "http://127.0.0.1:" + address.getPort();
        openWorkspace(url);
    }

    private boolean local(Uri uri) {
        return uri != null && "http".equals(uri.getScheme()) && "127.0.0.1".equals(uri.getHost()) &&
            uri.getUserInfo() == null && ("http://127.0.0.1:" + uri.getPort()).equals(origin);
    }

    private boolean navigate(Uri target, boolean mainFrame, boolean gesture) {
        if (local(target)) return false;
        // A user-opened web/OAuth link leaves the private WebView; no external page gets its bridge.
        if (mainFrame && gesture && target != null && target.getHost() != null && target.getUserInfo() == null &&
            ("https".equals(target.getScheme()) || "http".equals(target.getScheme()))) {
            try { startActivity(new Intent(Intent.ACTION_VIEW, target)); }
            catch (Exception error) { Toast.makeText(this, "No browser is available for this external link.", Toast.LENGTH_LONG).show(); }
        }
        return true;
    }

    private void openWorkspace(String url) {
        workspace = new WebView(this);
        workspace.setId(R.id.workspace_webview);
        WebView.setWebContentsDebuggingEnabled(false);
        WebSettings settings = workspace.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        workspace.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return navigate(request.getUrl(), request.isForMainFrame(), request.hasGesture());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String target) {
                return navigate(Uri.parse(target), true, true);
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) Toast.makeText(MainActivity.this,
                    "The local workspace could not load. Reopen Memory map.", Toast.LENGTH_LONG).show();
            }
        });
        workspace.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    Intent picker = params.createIntent().addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivityForResult(picker, FILE_PICKER);
                    return true;
                } catch (Exception error) {
                    fileCallback = null;
                    callback.onReceiveValue(null);
                    return true;
                }
            }
        });
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            downloads = new NativeDownloads(this, workspace, origin);
            voice = new NativeVoice(this, workspace, origin);
        }
        workspace.setDownloadListener((link, agent, disposition, mime, size) ->
            Toast.makeText(this, "Use the in-app download action. Update Android System WebView if saving is unavailable.", Toast.LENGTH_LONG).show());
        root.removeAllViews();
        root.addView(workspace, new FrameLayout.LayoutParams(-1, -1));
        workspace.loadUrl(url);
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == NativeVoice.PERMISSION && voice != null)
            voice.permissionResult(results.length > 0 && results[0] == android.content.pm.PackageManager.PERMISSION_GRANTED);
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == NativeDownloads.REQUEST && downloads != null) {
            downloads.onResult(result, data);
        } else if (request == FILE_PICKER && fileCallback != null) {
            Uri[] selected = WebChromeClient.FileChooserParams.parseResult(result, data);
            if (selected != null) {
                for (Uri uri : selected) {
                    if (uri == null || !"content".equals(uri.getScheme())) { selected = null; break; }
                }
            }
            ValueCallback<Uri[]> callback = fileCallback;
            fileCallback = null;
            callback.onReceiveValue(selected);
        }
    }

    @Override public void onBackPressed() {
        // Keep the vault and any pending external OAuth callback alive on backgrounding.
        moveTaskToBack(true);
    }

    @Override public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        fileCallback = null;
        if (downloads != null) downloads.destroy();
        if (voice != null) voice.destroy();
        if (workspace != null) {
            root.removeView(workspace);
            workspace.stopLoading();
            workspace.destroy();
            workspace = null;
        }
        super.onDestroy();
    }
}
