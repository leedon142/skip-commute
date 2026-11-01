package app.skipcommute.demo;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * 웹 ↔ 길안내 서비스 다리.
 * start(steps, idx, dest, muted) · update(steps, idx) · next() · stop() · speak(text) · setMuted(muted) · getState()
 * 이벤트: step {idx, reason} · location {lat, lng, accuracy, dist} · finished {reason: arrived|stopped}
 */
@CapacitorPlugin(
    name = "SkipNavigation",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }),
    }
)
public class SkipNavigationPlugin extends Plugin {

    @Override
    public void load() {
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
