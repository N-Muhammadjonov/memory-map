package com.memorymap.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class VaultService extends Service {
    static volatile String url;
    static volatile boolean failed;
    private volatile boolean stopping;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    @Override public void onCreate() {
        super.onCreate();
        url = null;
        failed = false;
        if (Build.VERSION.SDK_INT >= 26) {
            getSystemService(NotificationManager.class).createNotificationChannel(
                new NotificationChannel("vault", "Local workspace", NotificationManager.IMPORTANCE_LOW));
        }
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Intent stop = new Intent(this, VaultService.class).setAction("stop");
        PendingIntent stopIntent = PendingIntent.getService(this, 1, stop,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, "vault") : new Notification.Builder(this);
        startForeground(1, builder.setSmallIcon(android.R.drawable.ic_menu_edit)
            .setContentTitle("Memory map").setContentText("Your encrypted workspace is running locally.")
            .setContentIntent(open).addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stopIntent)
            .setOngoing(true).build());
        executor.submit(() -> {
            try {
                if (!Python.isStarted()) Python.start(new AndroidPlatform(this));
                String address = Python.getInstance().getModule("android_entry")
                    .callAttr("start", getFilesDir().getAbsolutePath()).toString();
                if (!stopping) url = address;
            } catch (Exception error) {
                failed = true;
            }
        });
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "stop".equals(intent.getAction())) stopSelf();
        return START_NOT_STICKY;
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onDestroy() {
        stopping = true;
        url = null;
        executor.submit(() -> {
            try {
                if (Python.isStarted()) Python.getInstance().getModule("android_entry").callAttr("stop");
            } catch (Exception ignored) { }
        });
        executor.shutdown();
        super.onDestroy();
    }
}
