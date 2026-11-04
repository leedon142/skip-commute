package app.skipcommute.demo;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 앱 안에 직접 만든 플러그인은 super.onCreate 전에 등록
        registerPlugin(SkipNavigationPlugin.class);
        super.onCreate(savedInstanceState);
        if (savedInstanceState == null) openFrom(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        openFrom(intent);
    }

    // 등교 알람·하교 알림을 눌러서 열면 해당 화면으로
    private void openFrom(Intent intent) {
        SkipNavigationPlugin.openFromNotification(intent == null ? null : intent.getStringExtra(CommuteAlarms.EXTRA_OPEN));
    }
}
