package com.memorymap.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.widget.TextView;

public final class MainActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private TextView message;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        message = new TextView(this);
        message.setGravity(Gravity.CENTER);
        message.setPadding(30, 30, 30, 30);
        message.setText("Opening your private Memory map workspace…");
        setContentView(message);
        Intent service = new Intent(this, VaultService.class);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(service);
        else startService(service);
        handler.post(this::openWhenReady);
    }

    private void openWhenReady() {
        if (isFinishing()) return;
        if (VaultService.failed) {
            message.setText("The local workspace could not start. Close Memory map and try again.");
            return;
        }
        String url = VaultService.url;
        if (url == null) {
            handler.postDelayed(this::openWhenReady, 200);
            return;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            finish();
        } catch (Exception error) {
            message.setText("Install a browser to open your private workspace.");
        }
    }

    @Override public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
}
