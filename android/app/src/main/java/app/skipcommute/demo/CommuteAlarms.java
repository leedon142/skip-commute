package app.skipcommute.demo;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * 웹 푸시 대신 휴대폰 안에서 울리는 등교 알람·하교 알림 (웹의 schedulePush와 같은 예약).
 * 등교: 알람 시각에 알람 소리(끌 때까지 반복) · 1시간 전에 다시 계산해서 3분 넘게 당겨지면 알람을 앞당김 (늦추지는 않음)
 * 하교: 수업 끝나기 5분 전에 실시간 하교 경로 알림.
 * 알림 문구는 울릴 때 서버(/api/push action=message)가 실시간으로 계산. 서버가 안 되면 기본 문구로 그대로 울림.
 * 예약은 앱 저장소에 남겨 두고 재부팅·앱 업데이트 뒤 다시 걸음.
 */
public class CommuteAlarms extends BroadcastReceiver {

    static final String ACTION_FIRE = "app.skipcommute.demo.ALARM_FIRE";
    static final String ACTION_CHECK = "app.skipcommute.demo.ALARM_CHECK";
    static final String ACTION_DISMISS = "app.skipcommute.demo.ALARM_DISMISS";
    static final String EXTRA_KIND = "kind";
    static final String EXTRA_OPEN = "skip.open";

    private static final String PREFS = "skip_alarms";
    private static final String MORNING_CHANNEL_ID = "skip_morning_alarm";
    private static final String BRIEF_CHANNEL_ID = "skip_commute_brief";
    private static final int MORNING_NOTIFICATION_ID = 4001;
    private static final int DISMISSAL_NOTIFICATION_ID = 4002;
    private static final int TEST_NOTIFICATION_ID = 4003;
    private static final long RECHECK_BEFORE_MS = 60 * 60000;
    private static final long ADVANCE_MIN_MS = 3 * 60000; // 이만큼 이상 당겨져야 알람을 옮김 (서버 push-send와 같음)
    private static final long RING_MS = 10 * 60000; // 끄지 않으면 10분 뒤 알람 멈춤
    private static final int NET_TIMEOUT_MS = 6000;

    // ---------------- 예약 ----------------

    /** job: { kind: morning|dismissal, at, query, plannedLeaveBy?, prepMin?, api } */
    static void schedule(Context c, JSONObject job) {
        String kind = job.optString("kind");
        prefs(c).edit().putString(kind, job.toString()).apply();
        arm(c, job);
    }

    static void cancel(Context c, String kind) {
        prefs(c).edit().remove(kind).apply();
        AlarmManager am = c.getSystemService(AlarmManager.class);
        am.cancel(pending(c, ACTION_FIRE, kind));
        am.cancel(pending(c, ACTION_CHECK, kind));
    }

    static JSONObject job(Context c, String kind) {
        String raw = prefs(c).getString(kind, null);
        try {
            return raw == null ? null : new JSONObject(raw);
        } catch (Exception e) {
            return null;
        }
    }

    /** 정확한 시각 알람 허용 여부 (안 되면 몇 분 늦게 울릴 수 있음) */
    static boolean canExact(Context c) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S || c.getSystemService(AlarmManager.class).canScheduleExactAlarms();
    }

    private static void arm(Context c, JSONObject job) {
        String kind = job.optString("kind");
        long at = job.optLong("at");
        long now = System.currentTimeMillis();
        if (at <= now) return;
        AlarmManager am = c.getSystemService(AlarmManager.class);
        PendingIntent fire = pending(c, ACTION_FIRE, kind);
        boolean exact = canExact(c);
        if ("morning".equals(kind)) {
            // 알람 시계로 등록: 상태바에 알람 아이콘, 절전 중에도 정시에 울림
            if (exact) am.setAlarmClock(new AlarmManager.AlarmClockInfo(at, openIntent(c, kind, 10)), fire);
            else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, fire);
            long checkAt = at - RECHECK_BEFORE_MS;
            if (job.has("prepMin") && checkAt > now + 10 * 60000 && !job.optBoolean("checked")) {
                set(am, exact, checkAt, pending(c, ACTION_CHECK, kind));
            }
        } else {
            set(am, exact, at, fire);
        }
    }

    private static void set(AlarmManager am, boolean exact, long at, PendingIntent pi) {
        if (exact) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
    }

    private static PendingIntent pending(Context c, String action, String kind) {
        Intent i = new Intent(c, CommuteAlarms.class).setAction(action)
            .setData(Uri.parse("skip-alarm://" + kind)).putExtra(EXTRA_KIND, kind);
        int code = (ACTION_CHECK.equals(action) ? 2 : 1) + ("morning".equals(kind) ? 0 : 4);
        return PendingIntent.getBroadcast(c, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** 알림을 누르면 앱의 해당 화면으로 (웹의 ?tab=3&mode=… 과 같은 주소) */
    private static PendingIntent openIntent(Context c, String kind, int code) {
        Intent i = new Intent(c, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_OPEN, "/?tab=3&mode=" + ("morning".equals(kind) ? "morning" : "dismissal") + "&from=push");
        return PendingIntent.getActivity(c, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // ---------------- 울릴 때 ----------------

    @Override
    public void onReceive(Context context, Intent intent) {
        Context c = context.getApplicationContext();
        String action = String.valueOf(intent.getAction());
        String kind = intent.getStringExtra(EXTRA_KIND);
        if (ACTION_DISMISS.equals(action)) {
            c.getSystemService(NotificationManager.class).cancel(MORNING_NOTIFICATION_ID);
            return;
        }
        if (!ACTION_FIRE.equals(action) && !ACTION_CHECK.equals(action)) {
            // 재부팅·앱 업데이트: 남은 예약을 다시 걸기
            for (String k : new String[] { "morning", "dismissal" }) {
                JSONObject job = job(c, k);
                if (job != null) arm(c, job);
            }
            return;
        }
        JSONObject job = kind == null ? null : job(c, kind);
        if (job == null) return;
        // 서버에서 문구를 받아오는 동안 잠깐 더 살아 있게
        PendingResult result = goAsync();
        new Thread(() -> {
            try {
                if (ACTION_CHECK.equals(action)) recheck(c, job);
                else fire(c, job, fetchMessage(job));
            } finally {
                result.finish();
            }
        }).start();
    }

    private static void fire(Context c, JSONObject job, JSONObject msg) {
        String kind = job.optString("kind");
        prefs(c).edit().remove(kind).apply();
        boolean morning = "morning".equals(kind);
        String title = msg != null ? msg.optString("title") : (morning ? "등교 준비할 시간이에요" : "곧 수업이 끝나요");
        String body = msg != null ? msg.optString("body") : (morning ? "눌러서 지금 기준 출발 시각과 경로를 확인하세요." : "눌러서 실시간 하교 경로를 확인하세요.");
        if (morning) ring(c, title, body);
        else notify(c, DISMISSAL_NOTIFICATION_ID, title, body, openIntent(c, kind, 11));
    }

    /** 등교 알람 1시간 전: 지금 날씨·교통으로 다시 계산해서 알람이 3분 넘게 당겨지면 옮김 */
    private static void recheck(Context c, JSONObject job) {
        try {
            job.put("checked", true);
            JSONObject msg = fetchMessage(job);
            long leaveBy = msg == null ? 0 : msg.optLong("leaveBy", 0);
            if (leaveBy > 0) {
                long newAlarm = leaveBy - job.optLong("prepMin") * 60000;
                if (newAlarm <= job.optLong("at") - ADVANCE_MIN_MS) {
                    if (newAlarm <= System.currentTimeMillis() + 60000) {
                        fire(c, job, msg);
                        return;
                    }
                    job.put("at", newAlarm);
                }
            }
            schedule(c, job);
        } catch (Exception ignored) {
        }
    }

    /** 실시간으로 계산한 알림 문구 { title, body, leaveBy }. 실패하면 null */
    private static JSONObject fetchMessage(JSONObject job) {
        String api = job.optString("api");
        if (api.isEmpty()) return null;
        HttpURLConnection conn = null;
        try {
            JSONObject req = new JSONObject().put("action", "message").put("kind", job.optString("kind"))
                .put("query", job.optString("query")).put("plannedLeaveBy", job.opt("plannedLeaveBy"));
            conn = (HttpURLConnection) new URL(api + "/api/push").openConnection();
            conn.setConnectTimeout(NET_TIMEOUT_MS);
            conn.setReadTimeout(NET_TIMEOUT_MS);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("content-type", "application/json");
            try (OutputStream out = conn.getOutputStream()) {
                out.write(req.toString().getBytes(StandardCharsets.UTF_8));
            }
            if (conn.getResponseCode() != 200) return null;
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                for (String line; (line = r.readLine()) != null; ) sb.append(line);
            }
            JSONObject msg = new JSONObject(sb.toString());
            return msg.optString("title").isEmpty() ? null : msg;
        } catch (Exception e) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    // ---------------- 알림 ----------------

    /** 알람: 끄기 전까지 알람 소리 반복 + 진동, 잠금화면에도 표시 */
    private static void ring(Context c, String title, String body) {
        channels(c);
        Intent off = new Intent(c, CommuteAlarms.class).setAction(ACTION_DISMISS);
        PendingIntent offPi = PendingIntent.getBroadcast(c, 9, off, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new NotificationCompat.Builder(c, MORNING_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(openIntent(c, "morning", 12))
            .addAction(0, "알람 끄기", offPi)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setTimeoutAfter(RING_MS)
            .build();
        n.flags |= Notification.FLAG_INSISTENT;
        c.getSystemService(NotificationManager.class).notify(MORNING_NOTIFICATION_ID, n);
    }

    private static void notify(Context c, int id, String title, String body, PendingIntent open) {
        channels(c);
        Notification n = new NotificationCompat.Builder(c, BRIEF_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_map)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build();
        c.getSystemService(NotificationManager.class).notify(id, n);
    }

    /** 알림 켜기를 눌렀을 때 바로 보내는 확인용 알림 (웹의 테스트 푸시와 같은 문구) */
    static void test(Context c) {
        notify(c, TEST_NOTIFICATION_ID, "알림이 켜졌어요",
            "수업 끝나기 전 하교 브리핑과 등교 알람을 이렇게 보내드려요. 눌러서 하교 경로 보기", openIntent(c, "dismissal", 13));
    }

    private static void channels(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        NotificationChannel alarm = new NotificationChannel(MORNING_CHANNEL_ID, "등교 알람", NotificationManager.IMPORTANCE_HIGH);
        alarm.setDescription("첫 수업에 맞춘 출발 알람 (날씨·실시간 교통 반영)");
        Uri sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        if (sound == null) sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        alarm.setSound(sound, new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build());
        alarm.enableVibration(true);
        alarm.setVibrationPattern(new long[] { 0, 800, 400, 800 });
        alarm.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(alarm);
        NotificationChannel brief = new NotificationChannel(BRIEF_CHANNEL_ID, "하교·알림 안내", NotificationManager.IMPORTANCE_HIGH);
        brief.setDescription("수업 끝나기 5분 전 하교 경로");
        brief.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(brief);
    }
}
