package app.skipcommute.demo;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 길안내 포그라운드 서비스: 앱을 닫거나 화면을 꺼도 위치로 단계를 넘기고, 음성 안내·잠금화면 알림을 맡음.
 * 단계 판정은 웹(index.html)의 resumeNavigation과 같은 규칙: 목표 반경(GPS 오차만큼, 최대 2배) 안에 들어오면 다음 단계,
 * 지하·GPS 끊김(60초)·목표 없음이면 예상 시각(timeAt)이 지나면 다음 단계.
 * 탈 버스 접근 알림도 맡음: 정류장 근처에서 버스 도착 정보를 보다가 곧 오면 헤드업 알림·진동·음성 (웹의 checkArrival과 같은 규칙).
 */
public class NavigationService extends Service {

    static final String ACTION_START = "start";
    static final String ACTION_UPDATE = "update";
    static final String ACTION_NEXT = "next";
    static final String ACTION_STOP = "stop";
    static final String ACTION_SPEAK = "speak";
    static final String ACTION_MUTE = "mute";
    static final String ACTION_REASON = "reason";
    static final String EXTRA_PAYLOAD = "payload";
    static final String EXTRA_TEXT = "text";
    static final String EXTRA_MUTED = "muted";

    private static final String CHANNEL_ID = "skip_nav";
    private static final int NOTIFICATION_ID = 1017;
    private static final String PREFS = "skip_nav";
    private static final long TICK_MS = 5000;
    private static final long GPS_STALE_MS = 60000;
    // 지하철 시각 보정·갈아탈 버스 안내처럼 웹이 실시간 정보를 붙여 말하는 단계는 웹이 말할 때까지 잠깐 기다림
    private static final long WEB_SPEECH_WAIT_MS = 8000;

    private static final String ARRIVE_CHANNEL_ID = "skip_bus_arrival";
    private static final int ARRIVE_NOTIFICATION_ID = 3001;
    private static final double ARRIVE_NEAR_M = 60;
    private static final double ARRIVE_LEFT_M = 400; // 타는 단계인데 정류장에서 이만큼 멀어졌으면 이미 탄 것
    private static final long ARRIVE_POLL_MS = 20000;
    private static final long ARRIVE_FAR_POLL_MS = 60000; // 5분 넘게 남았으면 1분마다 (서울시 API 한도 아끼기)

    /** 플러그인(웹)으로 상태를 알림 */
    interface Listener {
        void onStep(int idx, String reason);
        void onLocation(double lat, double lng, float accuracy, Double dist);
        void onFinished(String reason);
    }

    static Listener listener;
    static volatile boolean running;
    static volatile int currentIdx;
    static volatile Location lastLocation;
    static volatile long lastFixAt;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final List<JSONObject> steps = new ArrayList<>();
    private String dest = "";
    /** AI가 이 경로를 고른 이유 (알림의 '이유 듣기'를 누르면 읽음) */
    private String aiReason = "";
    private boolean muted;
    private LocationManager locationManager;
    private TextToSpeech tts;
    private boolean ttsReady;
    private final List<String> pendingSpeech = new ArrayList<>();
    private AudioManager audioManager;
    private AudioFocusRequest focusRequest;
    private int speaking;
    private Runnable webSpeechFallback;
    private boolean finishing;
    private String apiBase = "";
    static volatile String api = ""; // 상황 제보 화면(ReportActivity)이 쓰는 API 주소
    private final Set<String> arriveAlerted = new HashSet<>();
    private final ExecutorService net = Executors.newSingleThreadExecutor();
    private long arriveNextAt;
    private boolean arriveBusy;

    private final LocationListener locationListener = this::onLocation;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            checkTime();
            checkArrival();
            handler.postDelayed(this, TICK_MS);
        }
    };

    static Intent intent(Context ctx, String action) {
        return new Intent(ctx, NavigationService.class).setAction(action);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        createChannel();
        tts = new TextToSpeech(this, status -> {
            if (status != TextToSpeech.SUCCESS) return;
            tts.setLanguage(Locale.KOREAN);
            tts.setAudioAttributes(speechAttributes());
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) {}
                @Override public void onDone(String id) { handler.post(() -> utteranceEnded()); }
                @Override public void onError(String id) { handler.post(() -> utteranceEnded()); }
            });
            ttsReady = true;
            for (String text : pendingSpeech) say(text);
            pendingSpeech.clear();
        });
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        // 시스템이 서비스를 다시 만든 경우: 저장해 둔 안내를 이어감
        if (action == null) {
            if (!restore()) { stopSelf(); return START_NOT_STICKY; }
            startInForeground();
            return START_STICKY;
        }
        switch (action) {
            case ACTION_START:
                if (!load(intent.getStringExtra(EXTRA_PAYLOAD), true)) { stopSelf(); return START_NOT_STICKY; }
                startInForeground();
                announce(currentIdx, "start");
                break;
            case ACTION_UPDATE:
                if (running) load(intent.getStringExtra(EXTRA_PAYLOAD), false);
                updateNotification(null);
                break;
            case ACTION_NEXT:
                if (running) advance("manual");
                break;
            case ACTION_SPEAK:
                cancelWebSpeechFallback();
                say(intent.getStringExtra(EXTRA_TEXT));
                break;
            case ACTION_REASON:
                if (running && !aiReason.isEmpty()) say("AI 추천 이유예요. " + aiReason);
                break;
            case ACTION_MUTE:
                muted = intent.getBooleanExtra(EXTRA_MUTED, false);
                if (muted && tts != null) tts.stop();
                save();
                break;
            case ACTION_STOP:
                finish("stopped", false);
                break;
        }
        return START_STICKY;
    }

    /** start: 경로를 새로 받음. update: 웹이 바꾼 예상 시각·안내 문구만 반영 (단계는 뒤로 가지 않음) */
    private boolean load(String payload, boolean fresh) {
        if (payload == null) return false;
        try {
            JSONObject p = new JSONObject(payload);
            JSONArray arr = p.getJSONArray("steps");
            if (arr.length() == 0) return false;
            steps.clear();
            for (int i = 0; i < arr.length(); i++) steps.add(arr.getJSONObject(i));
            int idx = Math.min(p.optInt("idx", 0), steps.size() - 1);
            if (fresh) {
                dest = p.optString("dest", "");
                aiReason = p.optString("aiReason", "");
                muted = p.optBoolean("muted", false);
                apiBase = p.optString("api", apiBase);
                api = apiBase;
                JSONArray alerted = p.optJSONArray("alerted");
                for (int i = 0; alerted != null && i < alerted.length(); i++) arriveAlerted.add(alerted.optString(i));
                currentIdx = idx;
                finishing = false;
            } else if (idx > currentIdx) {
                currentIdx = idx;
            }
            running = true;
            save();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private void save() {
        try {
            JSONObject p = new JSONObject();
            JSONArray arr = new JSONArray();
            for (JSONObject s : steps) arr.put(s);
            p.put("steps", arr).put("idx", currentIdx).put("dest", dest).put("muted", muted)
                .put("api", apiBase).put("aiReason", aiReason).put("alerted", new JSONArray(arriveAlerted));
            prefs().edit().putString("nav", p.toString()).apply();
        } catch (Exception ignored) {}
    }

    private boolean restore() {
        return load(prefs().getString("nav", null), true);
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private void startInForeground() {
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION : 0;
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(null), type);
        startLocation();
        handler.removeCallbacks(tick);
        handler.postDelayed(tick, TICK_MS);
    }

    private void startLocation() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED
            && ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            return; // 위치 권한이 없으면 예상 시각으로만 안내
        }
        locationManager.removeUpdates(locationListener);
        try {
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 2000, 0, locationListener, Looper.getMainLooper());
            }
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 5000, 0, locationListener, Looper.getMainLooper());
            }
        } catch (SecurityException ignored) {}
    }

    private void onLocation(Location loc) {
        if (!running || finishing) return;
        // 네트워크 위치가 방금 받은 GPS보다 부정확하면 무시
        if (lastLocation != null && LocationManager.NETWORK_PROVIDER.equals(loc.getProvider())
            && System.currentTimeMillis() - lastFixAt < 10000 && loc.getAccuracy() > lastLocation.getAccuracy()) return;
        lastLocation = loc;
        lastFixAt = System.currentTimeMillis();
        JSONObject step = steps.get(currentIdx);
        Double dist = distanceTo(step, loc);
        if (listener != null) listener.onLocation(loc.getLatitude(), loc.getLongitude(), loc.getAccuracy(), dist);
        updateNotification(dist);
        if (dist == null) return;
        double radius = step.optDouble("radius", 30);
        if (dist <= Math.min(radius * 2, Math.max(radius, loc.getAccuracy()))) advance("gps");
    }

    private Double distanceTo(JSONObject step, Location loc) {
        return distanceToPoint(step.optJSONObject("target"), loc);
    }

    private Double distanceToPoint(JSONObject t, Location loc) {
        if (t == null || !t.has("lat")) return null;
        float[] out = new float[1];
        Location.distanceBetween(loc.getLatitude(), loc.getLongitude(), t.optDouble("lat"), t.optDouble("lng"), out);
        return (double) out[0];
    }

    private void checkTime() {
        if (!running || finishing) return;
        JSONObject step = steps.get(currentIdx);
        if (!step.has("timeAt") || step.isNull("timeAt")) return;
        boolean gpsStale = System.currentTimeMillis() - lastFixAt > GPS_STALE_MS;
        boolean noTarget = step.optJSONObject("target") == null;
        if ((step.optBoolean("underground") || gpsStale || noTarget) && System.currentTimeMillis() >= step.optLong("timeAt")) {
            advance("time");
        }
    }

    private void advance(String reason) {
        currentIdx += 1;
        if (currentIdx >= steps.size()) {
            say(dest.isEmpty() ? "목적지에 도착했어요. 길안내를 마칠게요." : dest + "에 도착했어요. 길안내를 마칠게요.");
            finish("arrived", true);
            return;
        }
        save();
        announce(currentIdx, reason);
        if (listener != null) listener.onStep(currentIdx, reason);
        updateNotification(lastLocation != null ? distanceTo(steps.get(currentIdx), lastLocation) : null);
    }

    /** 단계 안내 말하기. 웹이 실시간 정보를 붙여 말하는 단계(rich)는 웹이 살아 있으면 웹에 맡김 */
    private void announce(int idx, String reason) {
        JSONObject step = steps.get(idx);
        String text = step.optString("say", "");
        cancelWebSpeechFallback();
        if (step.optBoolean("rich") && listener != null && !"start".equals(reason)) {
            webSpeechFallback = () -> say(text);
            handler.postDelayed(webSpeechFallback, WEB_SPEECH_WAIT_MS);
        } else {
            say(text);
        }
    }

    private void cancelWebSpeechFallback() {
        if (webSpeechFallback != null) handler.removeCallbacks(webSpeechFallback);
        webSpeechFallback = null;
    }

    private void say(String text) {
        if (text == null || text.isEmpty() || muted) return;
        if (!ttsReady) { pendingSpeech.add(text); return; }
        // 음악은 끄지 않고 잠깐 소리만 줄였다가 말이 끝나면 돌려줌 (일시적 오디오 포커스)
        if (speaking == 0) requestFocus();
        speaking += 1;
        Bundle params = new Bundle();
        params.putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, AudioManager.STREAM_MUSIC);
        tts.speak(text, TextToSpeech.QUEUE_ADD, params, "skip-" + System.nanoTime());
    }

    private void utteranceEnded() {
        speaking = Math.max(0, speaking - 1);
        if (speaking == 0) {
            abandonFocus();
            if (finishing) shutdown();
        }
    }

    // 미디어 소리로 재생: 길안내 음성(NAVIGATION_GUIDANCE)은 안드로이드 화면 녹화에 안 담겨서 시연 영상에 안 나옴
    private AudioAttributes speechAttributes() {
        return new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build();
    }

    private void requestFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(speechAttributes()) // 재생과 같은 미디어로 요청해도 음악은 줄어듦 (에뮬레이터 확인)
                .setWillPauseWhenDucked(false)
                .build();
            audioManager.requestAudioFocus(focusRequest);
        } else {
            audioManager.requestAudioFocus(null, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK);
        }
    }

    private void abandonFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (focusRequest != null) audioManager.abandonAudioFocusRequest(focusRequest);
            focusRequest = null;
        } else {
            audioManager.abandonAudioFocus(null);
        }
    }

    /** 끝내기: 도착 안내처럼 말할 게 남아 있으면 말이 끝난 뒤 정리 */
    private void finish(String reason, boolean afterSpeech) {
        running = false;
        finishing = true;
        cancelWebSpeechFallback();
        prefs().edit().remove("nav").apply();
        if (listener != null) listener.onFinished(reason);
        if (!afterSpeech || speaking == 0 || muted) shutdown();
        else handler.postDelayed(this::shutdown, 15000); // 말이 안 끝나도 15초 뒤엔 정리
    }

    private void shutdown() {
        handler.removeCallbacksAndMessages(null);
        locationManager.removeUpdates(locationListener);
        if (tts != null) tts.stop();
        abandonFocus();
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    // ---------------- 탈 버스 접근 알림 ----------------

    /** 정류장 60m 안(GPS가 없으면 정류장 도착 예정 2분 전부터)이면 도착 정보를 보고, 곧 오면 그 버스는 한 번만 알림 */
    private void checkArrival() {
        if (!running || finishing || arriveBusy || apiBase.isEmpty()) return;
        JSONObject step = steps.get(currentIdx);
        JSONObject bus = step.optJSONObject("board");
        long now = System.currentTimeMillis();
        if (bus == null || now < arriveNextAt || now > bus.optLong("until")) return;
        String key = bus.optString("ars") + ":" + bus.optString("route") + ":" + bus.optLong("until");
        if (arriveAlerted.contains(key)) return;
        Double d = lastLocation != null && now - lastFixAt < GPS_STALE_MS ? distanceToPoint(bus.optJSONObject("pos"), lastLocation) : null;
        boolean riding = !step.isNull("timeAt"); // '버스 타기' 단계 (정류장에 도착함)
        if (riding && d != null && d > ARRIVE_LEFT_M) return;
        if (!riding && (d != null ? d > ARRIVE_NEAR_M : now < bus.optLong("stopAt") - 120000)) return;
        arriveBusy = true;
        int idx = currentIdx;
        String ars = bus.optString("ars");
        String route = bus.optString("route");
        String from = bus.optString("from");
        net.execute(() -> {
            JSONObject a = fetchArrival(ars, route);
            handler.post(() -> {
                arriveBusy = false;
                double sec = a == null || a.isNull("seconds") ? Double.NaN : a.optDouble("seconds");
                arriveNextAt = System.currentTimeMillis() + (sec > 300 ? ARRIVE_FAR_POLL_MS : ARRIVE_POLL_MS);
                if (!running || currentIdx != idx || a == null) return;
                int stopsAway = a.isNull("stopsAway") ? -1 : a.optInt("stopsAway", -1);
                if (!busApproaching(a.optString("message", ""), stopsAway, sec)) return;
                arriveAlerted.add(key);
                save();
                showArrivalAlert(route, from);
            });
        });
    }

    /** '곧 도착'·'[1번째 전]'이거나 90초 안. 모르는 값은 stopsAway -1, seconds NaN */
    static boolean busApproaching(String message, int stopsAway, double seconds) {
        return (message != null && message.contains("곧 도착")) || stopsAway == 1 || seconds <= 90;
    }

    /** 우리 서버(/api/bus)의 그 노선 첫 차. 서울시 키는 서버에만 있음 */
    private JSONObject fetchArrival(String ars, String route) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(apiBase + "/api/bus?ars=" + URLEncoder.encode(ars, "UTF-8")).openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            if (c.getResponseCode() != 200) return null;
            StringBuilder body = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
                for (String line; (line = r.readLine()) != null; ) body.append(line);
            }
            JSONArray routes = new JSONObject(body.toString()).optJSONArray("routes");
            for (int i = 0; routes != null && i < routes.length(); i++) {
                JSONObject rt = routes.optJSONObject(i);
                if (rt == null || !route.equals(rt.optString("route"))) continue;
                JSONArray arr = rt.optJSONArray("arrivals");
                return arr != null && arr.length() > 0 ? arr.optJSONObject(0) : null;
            }
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.disconnect();
        }
        return null;
    }

    /** 다른 앱을 보고 있어도 화면 위에 뜨는 헤드업 알림 + 진동 + 음성 */
    private void showArrivalAlert(String route, String from) {
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent openPi = PendingIntent.getActivity(this, 2, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new NotificationCompat.Builder(this, ARRIVE_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_map)
            .setContentTitle("곧 " + route + "번 버스 도착")
            .setContentText(from + " · 탑승을 준비하세요")
            .setContentIntent(openPi)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setVibrate(new long[] { 0, 500, 200, 500 })
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setTimeoutAfter(10 * 60000)
            .build();
        getSystemService(NotificationManager.class).notify(ARRIVE_NOTIFICATION_ID, n);
        say("곧 " + route + "번 버스가 도착해요. 탑승을 준비하세요.");
    }

    @Override
    public void onDestroy() {
        running = false;
        net.shutdownNow();
        handler.removeCallbacksAndMessages(null);
        if (locationManager != null) locationManager.removeUpdates(locationListener);
        if (tts != null) tts.shutdown();
        abandonFocus();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ---------------- 잠금화면·알림창 카드 ----------------

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        // 소리는 음성 안내가 맡으므로 알림 자체는 조용히
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "길안내", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("길안내 중 지금 할 일과 남은 거리");
        ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        getSystemService(NotificationManager.class).createNotificationChannel(ch);
        // 탈 버스 접근: 화면 위에 뜨고 진동. 소리는 음성 안내가 하므로 알림음은 끔
        NotificationChannel arrive = new NotificationChannel(ARRIVE_CHANNEL_ID, "버스 도착 알림", NotificationManager.IMPORTANCE_HIGH);
        arrive.setDescription("탈 버스가 곧 정류장에 올 때");
        arrive.setSound(null, null);
        arrive.enableVibration(true);
        arrive.setVibrationPattern(new long[] { 0, 500, 200, 500 });
        arrive.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        getSystemService(NotificationManager.class).createNotificationChannel(arrive);
    }

    private Notification buildNotification(Double dist) {
        JSONObject step = steps.isEmpty() ? new JSONObject() : steps.get(Math.min(currentIdx, steps.size() - 1));
        boolean last = currentIdx >= steps.size() - 1;
        // 마지막 단계 이름엔 집 이름이 들어갈 수 있어 잠금화면엔 '목적지'로만
        String title = last ? "목적지까지 걷기" : step.optString("label", "길안내");
        String where = dist != null
            ? "남은 거리 " + (dist >= 1000 ? String.format(Locale.KOREA, "%.1fkm", dist / 1000) : Math.round(dist) + "m")
            : (step.optBoolean("underground") ? "예상 시각으로 안내" : "위치 확인 중");
        String text = (currentIdx + 1) + "/" + steps.size() + "단계 · " + where;

        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent openPi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stopPi = PendingIntent.getService(this, 1, intent(this, ACTION_STOP), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        // 잠금을 풀지 않고 바로 말로 제보 (ReportActivity는 잠금화면 위에 뜸)
        Intent report = new Intent(this, ReportActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent reportPi = PendingIntent.getActivity(this, 3, report, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_map)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(openPi);
        // AI 추천 이유는 길어서 시작할 때 바로 읽지 않고, 듣고 싶을 때 누르게 함
        if (!aiReason.isEmpty()) {
            PendingIntent reasonPi = PendingIntent.getService(this, 4, intent(this, ACTION_REASON), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            b.addAction(0, "이유 듣기", reasonPi);
        }
        return b
            .addAction(0, "상황 제보", reportPi)
            .addAction(0, "길안내 종료", stopPi)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_NAVIGATION)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build();
    }

    private void updateNotification(Double dist) {
        if (!running) return;
        getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, buildNotification(dist));
    }
}
