package app.skipcommute.demo;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.location.Location;
import android.location.LocationManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

// 잠금화면 안내 카드의 '상황 제보' → 잠금을 풀지 않고 바로 녹음 (말이 끝나면 자동 전송) 또는 글로 적어 보내기
// 서버(/api/reports kind=situation)에서 AI(Gemini)가 사고·정체·날씨로 정리하고, 결과는 길안내 음성으로 읽어 줌
public class ReportActivity extends Activity {
    private static final int RATE = 16000;
    private static final int MAX_REC_MS = 20000;
    // 말소리로 볼 크기, 말이 끝났다고 볼 조용한 시간 (이어폰 마이크 기준 대략값)
    private static final int VOICE_LEVEL = 1500;
    private static final int QUIET_LEVEL = 600;
    private static final int END_SILENCE_MS = 1500;
    private static final int REQ_MIC = 7;

    private final Handler main = new Handler(Looper.getMainLooper());
    private TextView status;
    private EditText input;
    private Button micButton;
    private volatile boolean recording;
    private volatile boolean sending;
    private Thread recorder;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        setTitle("상황 제보");
        int pad = dp(18);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(pad, pad, pad, pad);
        root.setBackgroundColor(Color.WHITE);

        TextView title = new TextView(this);
        title.setText("상황 제보");
        title.setTextSize(18);
        title.setTextColor(Color.rgb(15, 23, 42));
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        root.addView(title);

        TextView hint = new TextView(this);
        hint.setText("정류장 줄(몇 명쯤, 만차로 지나감)이나 사고·정체·갑작스러운 비나 눈을 말하거나 적어 주세요. AI가 정리해서 공유해요.");
        hint.setTextSize(12);
        hint.setTextColor(Color.rgb(100, 116, 139));
        hint.setPadding(0, dp(4), 0, dp(10));
        root.addView(hint);

        status = new TextView(this);
        status.setTextSize(14);
        status.setTextColor(Color.rgb(37, 99, 235));
        status.setPadding(0, 0, 0, dp(10));
        root.addView(status);

        input = new EditText(this);
        input.setHint("글로 적기 (예: 줄 30명쯤, 7211 만차 통과)");
        input.setTextSize(14);
        input.setOnFocusChangeListener((v, focused) -> { if (focused) stopRecording(); });
        root.addView(input);

        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.END);
        row.setPadding(0, dp(10), 0, 0);
        Button close = new Button(this);
        close.setText("닫기");
        close.setOnClickListener(v -> finish());
        micButton = new Button(this);
        micButton.setOnClickListener(v -> { if (recording) stopRecording(); else startRecording(); });
        Button send = new Button(this);
        send.setText("보내기");
        send.setOnClickListener(v -> sendNow());
        row.addView(close);
        row.addView(micButton);
        row.addView(send);
        root.addView(row);
        setContentView(root);
        getWindow().setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT);

        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) startRecording();
        else requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQ_MIC);
        renderMic();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (code != REQ_MIC) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) startRecording();
        else show("마이크 권한이 없어서 글로만 보낼 수 있어요");
    }

    @Override
    protected void onDestroy() {
        recording = false;
        super.onDestroy();
    }

    private void renderMic() {
        micButton.setText(recording ? "녹음 멈춤" : "다시 말하기");
    }

    private void show(String text) {
        main.post(() -> status.setText(text));
    }

    private void startRecording() {
        if (recording || sending) return;
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQ_MIC);
            return;
        }
        recording = true;
        renderMic();
        show("듣고 있어요… 말이 끝나면 자동으로 보내요");
        recorder = new Thread(this::record);
        recorder.start();
    }

    private void stopRecording() {
        recording = false;
        main.post(this::renderMic);
    }

    // 녹음: 말소리가 나온 뒤 END_SILENCE_MS 동안 조용하면(또는 최대 MAX_REC_MS) 끝내고 자동 전송. 멈춤 버튼이면 전송 안 함
    private void record() {
        int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        AudioRecord rec;
        try {
            rec = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, RATE));
            rec.startRecording();
        } catch (Exception e) {
            recording = false;
            main.post(this::renderMic);
            show("녹음을 시작하지 못했어요. 글로 적어 주세요");
            return;
        }
        ByteArrayOutputStream pcm = new ByteArrayOutputStream();
        short[] buf = new short[RATE / 10];
        boolean spoke = false;
        int quietMs = 0;
        int totalMs = 0;
        boolean auto = false;
        while (recording) {
            int n = rec.read(buf, 0, buf.length);
            if (n <= 0) continue;
            int peak = 0;
            for (int i = 0; i < n; i++) {
                peak = Math.max(peak, Math.abs(buf[i]));
                pcm.write(buf[i] & 0xff);
                pcm.write((buf[i] >> 8) & 0xff);
            }
            int ms = n * 1000 / RATE;
            totalMs += ms;
            if (peak > VOICE_LEVEL) { spoke = true; quietMs = 0; }
            else if (peak < QUIET_LEVEL && spoke) quietMs += ms;
            if ((spoke && quietMs >= END_SILENCE_MS) || totalMs >= MAX_REC_MS) { auto = true; break; }
        }
        rec.stop();
        rec.release();
        recording = false;
        main.post(this::renderMic);
        if (auto && spoke) send(null, wav(pcm.toByteArray()));
        else if (auto) show("말소리가 안 들렸어요. 다시 말하거나 글로 적어 주세요");
    }

    private void sendNow() {
        String text = input.getText().toString().trim();
        if (text.length() >= 2) {
            stopRecording();
            send(text, null);
        } else {
            show("무슨 일이 있는지 말하거나 적어 주세요");
        }
    }

    private void send(String text, byte[] wav) {
        if (sending) return;
        sending = true;
        show("AI가 제보를 정리하는 중…");
        new Thread(() -> {
            try {
                Location loc = location();
                if (loc == null) throw new IllegalStateException("위치를 아직 못 잡았어요");
                JSONObject body = new JSONObject()
                    .put("kind", "situation")
                    .put("lat", loc.getLatitude())
                    .put("lng", loc.getLongitude());
                if (wav != null) body.put("audio", Base64.encodeToString(wav, Base64.NO_WRAP));
                else body.put("text", text);
                JSONObject res = post(NavigationService.api + "/api/reports", body);
                JSONObject report = res.optJSONObject("report");
                if (report == null) throw new IllegalStateException(res.optString("error", "제보 실패"));
                String done = "제보를 공유했어요. " + report.optString("type") + ", " + report.optString("summary");
                show(done);
                speak(done);
                main.postDelayed(this::finish, 2500);
            } catch (Exception e) {
                String msg = e.getMessage() != null ? e.getMessage() : "제보 실패";
                show("제보 실패: " + msg);
                speak("제보를 보내지 못했어요. " + msg);
                sending = false;
            }
        }).start();
    }

    private Location location() {
        Location loc = NavigationService.lastLocation;
        if (loc != null) return loc;
        try {
            LocationManager lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
            for (String p : new String[] { LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER }) {
                Location l = lm.getLastKnownLocation(p);
                if (l != null) return l;
            }
        } catch (SecurityException ignored) {}
        return null;
    }

    // 길안내 음성으로 결과를 읽어 줌 (안내 중이 아니면 화면 글자만)
    private void speak(String text) {
        if (!NavigationService.running) return;
        try {
            startService(NavigationService.intent(this, NavigationService.ACTION_SPEAK).putExtra(NavigationService.EXTRA_TEXT, text));
        } catch (Exception ignored) {}
    }

    private static JSONObject post(String url, JSONObject body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(8000);
        c.setReadTimeout(20000);
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("content-type", "application/json");
        try (OutputStream out = c.getOutputStream()) { out.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
        int code = c.getResponseCode();
        try (InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream()) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            for (int n; in != null && (n = in.read(chunk)) > 0; ) b.write(chunk, 0, n);
            String s = b.toString("UTF-8");
            try { return new JSONObject(s); } catch (Exception e) { return new JSONObject().put("error", "서버 응답 오류 (" + code + ")"); }
        } finally {
            c.disconnect();
        }
    }

    // 16kHz 모노 16비트 PCM → WAV
    private static byte[] wav(byte[] pcm) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(44 + pcm.length);
        writeStr(out, "RIFF"); writeInt(out, 36 + pcm.length); writeStr(out, "WAVE");
        writeStr(out, "fmt "); writeInt(out, 16); writeShort(out, 1); writeShort(out, 1);
        writeInt(out, RATE); writeInt(out, RATE * 2); writeShort(out, 2); writeShort(out, 16);
        writeStr(out, "data"); writeInt(out, pcm.length);
        out.write(pcm, 0, pcm.length);
        return out.toByteArray();
    }
    private static void writeStr(ByteArrayOutputStream o, String s) { for (char ch : s.toCharArray()) o.write(ch); }
    private static void writeInt(ByteArrayOutputStream o, int v) { for (int i = 0; i < 4; i++) o.write((v >> (8 * i)) & 0xff); }
    private static void writeShort(ByteArrayOutputStream o, int v) { o.write(v & 0xff); o.write((v >> 8) & 0xff); }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
