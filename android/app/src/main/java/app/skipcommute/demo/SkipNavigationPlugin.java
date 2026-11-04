package app.skipcommute.demo;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import org.json.JSONObject;

/**
 * 웹 ↔ 길안내 서비스 다리.
 * start(steps, idx, dest, muted) · update(steps, idx) · next() · stop() · speak(text) · setMuted(muted) · getState()
 * 이벤트: step {idx, reason} · location {lat, lng, accuracy, dist} · finished {reason: arrived|stopped}
 * 등교 알람·하교 알림 (CommuteAlarms): alarmPermission() · alarmState() · scheduleAlarm(job) · cancelAlarm(kind) · testAlarm()
 * 알림을 눌러 열린 화면 주소: takeOpen() → {url}, 이벤트 open
 */
@CapacitorPlugin(
    name = "SkipNavigation",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }),
    }
)
public class SkipNavigationPlugin extends Plugin {

    private static SkipNavigationPlugin instance;
    private static String pendingOpen;

    /** MainActivity가 알림으로 열렸을 때. 웹이 준비 전이면 takeOpen()으로 가져감 */
    static void openFromNotification(String url) {
        if (url == null) return;
        pendingOpen = url;
        if (instance != null) instance.notifyListeners("open", new JSObject(), true);
    }

    @Override
    public void load() {
        instance = this;
        NavigationService.listener = new NavigationService.Listener() {
            @Override
            public void onStep(int idx, String reason) {
                JSObject o = new JSObject();
                o.put("idx", idx);
                o.put("reason", reason);
                notifyListeners("step", o, true);
            }

            @Override
            public void onLocation(double lat, double lng, float accuracy, Double dist) {
                JSObject o = new JSObject();
                o.put("lat", lat);
                o.put("lng", lng);
                o.put("accuracy", accuracy);
                o.put("dist", dist);
                notifyListeners("location", o);
            }

            @Override
            public void onFinished(String reason) {
                JSObject o = new JSObject();
                o.put("reason", reason);
                notifyListeners("finished", o, true);
            }
        };
    }

    @Override
    protected void handleOnDestroy() {
        NavigationService.listener = null;
        instance = null;
    }

    /** 안내 시작: 위치·알림 권한을 이때 물어봄. 위치를 거부해도 예상 시각으로 안내는 계속 */
    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            requestPermissionForAlias("location", call, "afterLocation");
            return;
        }
        afterLocation(call);
    }

    @PermissionCallback
    private void afterLocation(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "afterNotifications");
            return;
        }
        afterNotifications(call);
    }

    @PermissionCallback
    private void afterNotifications(PluginCall call) {
        Intent i = NavigationService.intent(getContext(), NavigationService.ACTION_START)
            .putExtra(NavigationService.EXTRA_PAYLOAD, call.getData().toString());
        ContextCompat.startForegroundService(getContext(), i);
        JSObject out = new JSObject();
        out.put("location", getPermissionState("location") == PermissionState.GRANTED);
        out.put("notifications", Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState("notifications") == PermissionState.GRANTED);
        call.resolve(out);
    }

    @PluginMethod
    public void update(PluginCall call) {
        send(NavigationService.ACTION_UPDATE, call.getData().toString(), null, null);
        call.resolve();
    }

    @PluginMethod
    public void next(PluginCall call) {
        send(NavigationService.ACTION_NEXT, null, null, null);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        send(NavigationService.ACTION_STOP, null, null, null);
        call.resolve();
    }

    @PluginMethod
    public void speak(PluginCall call) {
        send(NavigationService.ACTION_SPEAK, null, call.getString("text", ""), null);
        call.resolve();
    }

    @PluginMethod
    public void setMuted(PluginCall call) {
        send(NavigationService.ACTION_MUTE, null, null, call.getBoolean("muted", false));
        call.resolve();
    }

    @PluginMethod
    public void getState(PluginCall call) {
        JSObject o = new JSObject();
        o.put("running", NavigationService.running);
        o.put("idx", NavigationService.currentIdx);
        if (NavigationService.lastLocation != null) {
            o.put("lat", NavigationService.lastLocation.getLatitude());
            o.put("lng", NavigationService.lastLocation.getLongitude());
            o.put("fixAt", NavigationService.lastFixAt);
        }
        call.resolve(o);
    }

    @PluginMethod
    public void takeOpen(PluginCall call) {
        JSObject o = new JSObject();
        o.put("url", pendingOpen);
        pendingOpen = null;
        call.resolve(o);
    }

    // ---------------- 등교 알람·하교 알림 ----------------

    /** 알림 켜기 버튼에서: 알림 권한을 이때 물어봄 */
    @PluginMethod
    public void alarmPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "afterAlarmPermission");
            return;
        }
        alarmState(call);
    }

    @PermissionCallback
    private void afterAlarmPermission(PluginCall call) {
        alarmState(call);
    }

    /** notifications: 알림 허용 · exact: 정시 알람 허용 · morning/dismissal: 걸려 있는 예약 시각 */
    @PluginMethod
    public void alarmState(PluginCall call) {
        JSObject o = new JSObject();
        o.put("notifications", NotificationManagerCompat.from(getContext()).areNotificationsEnabled());
        o.put("exact", CommuteAlarms.canExact(getContext()));
        for (String kind : new String[] { "morning", "dismissal" }) {
            JSONObject job = CommuteAlarms.job(getContext(), kind);
            o.put(kind, job == null ? null : job.optLong("at"));
        }
        call.resolve(o);
    }

    @PluginMethod
    public void scheduleAlarm(PluginCall call) {
        String kind = call.getString("kind");
        long at = call.getData().optLong("at", 0);
        if (!"morning".equals(kind) && !"dismissal".equals(kind) || at <= 0) {
            call.reject("kind(morning|dismissal)와 at이 필요해요");
            return;
        }
        CommuteAlarms.schedule(getContext(), call.getData());
        JSObject o = new JSObject();
        o.put("at", at);
        o.put("exact", CommuteAlarms.canExact(getContext()));
        call.resolve(o);
    }

    @PluginMethod
    public void cancelAlarm(PluginCall call) {
        CommuteAlarms.cancel(getContext(), call.getString("kind", ""));
        call.resolve();
    }

    @PluginMethod
    public void testAlarm(PluginCall call) {
        CommuteAlarms.test(getContext());
        call.resolve();
    }

    // 실행 중이 아닐 때 보낸 명령(말하기 등)은 서비스를 새로 띄우지 않음
    private void send(String action, String payload, String text, Boolean muted) {
        if (!NavigationService.running && !NavigationService.ACTION_STOP.equals(action)) return;
        Intent i = NavigationService.intent(getContext(), action);
        if (payload != null) i.putExtra(NavigationService.EXTRA_PAYLOAD, payload);
        if (text != null) i.putExtra(NavigationService.EXTRA_TEXT, text);
        if (muted != null) i.putExtra(NavigationService.EXTRA_MUTED, muted);
        getContext().startService(i);
    }
}
