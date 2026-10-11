package com.wesbos.homehq;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ResolveInfo;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebViewClient;

/**
 * Full-screen kiosk WebView for the Home HQ wall tablet.
 * - Immersive mode hides the status + navigation bars (true 1280x800).
 * - Exit: hold two fingers still on the screen for 1.5s to open the regular launcher.
 * - It is a HOME app: set it as the default Home so it starts on boot and Home returns here.
 * - The last URL passed in a VIEW intent is remembered and loaded on every later start.
 * - Remote debugging is OFF unless launched with the debug extra (every app on this device
 *   gets root, so the devtools socket should only exist while actively debugging):
 *     adb shell am start -n com.wesbos.homehq/.MainActivity --ez debug true
 * - Launch with a URL: adb shell am start -a android.intent.action.VIEW -d <url> -n com.wesbos.homehq/.MainActivity
 */
public class MainActivity extends Activity {
  static final String TAG = "HomeHQ";
  static final String DEFAULT_URL = "https://home-dashboard.wesbos.workers.dev/";
  static final long EXIT_HOLD_MS = 1500;
  static final long RETRY_MS = 10000;
  static final float EXIT_SLOP_PX = 60;

  private WebView web;
  private String currentUrl;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private final int[] exitIds = new int[2];
  private final float[] exitX = new float[2];
  private final float[] exitY = new float[2];
  private boolean exitArmed;

  private final Runnable exitToLauncher = new Runnable() {
    @Override
    public void run() {
      exitArmed = false;
      Log.i(TAG, "Two-finger hold: exiting to launcher");
      // This activity is itself the HOME app, so a plain HOME intent would land back here.
      Intent home = new Intent(Intent.ACTION_MAIN);
      home.addCategory(Intent.CATEGORY_HOME);
      for (ResolveInfo ri : getPackageManager().queryIntentActivities(home, 0)) {
        String pkg = ri.activityInfo.packageName;
        if (pkg.equals(getPackageName()) || pkg.equals("com.android.settings")) continue;
        home.setClassName(pkg, ri.activityInfo.name);
        break;
      }
      if (home.getComponent() == null) home = new Intent(Settings.ACTION_SETTINGS);
      home.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      startActivity(home);
    }
  };

  private final Runnable retryLoad = new Runnable() {
    @Override
    public void run() {
      Log.i(TAG, "Retrying " + currentUrl);
      web.loadUrl(currentUrl);
    }
  };

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    applyDebugFlag(getIntent());
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
        | WindowManager.LayoutParams.FLAG_FULLSCREEN);

    web = new WebView(this);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setUseWideViewPort(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    // The dashboard is https but talks to Home Assistant on the LAN over http/ws.
    s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
    web.setWebViewClient(new WebViewClient() { // keep navigation inside the kiosk
      @Override
      public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
        if (!req.isForMainFrame()) return;
        // Typically Wi-Fi not up yet after boot: retry instead of showing an error page forever.
        Log.w(TAG, "Load failed (" + err.getErrorCode() + " " + err.getDescription() + ")");
        handler.removeCallbacks(retryLoad);
        handler.postDelayed(retryLoad, RETRY_MS);
      }
    });
    setContentView(web);

    load(getIntent().getDataString());
  }

  /** Loads an explicitly passed URL and remembers it; with none, loads the remembered one. */
  private void load(String url) {
    SharedPreferences prefs = getSharedPreferences("kiosk", MODE_PRIVATE);
    if (url != null) {
      prefs.edit().putString("url", url).commit();
    } else {
      url = prefs.getString("url", DEFAULT_URL);
    }
    currentUrl = url;
    handler.removeCallbacks(retryLoad);
    web.loadUrl(url);
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    applyDebugFlag(intent);
    String url = intent.getDataString();
    if (url != null) load(url);
  }

  /** Remote debugging only when explicitly requested; any normal launch turns it back off. */
  private void applyDebugFlag(Intent intent) {
    boolean debug = intent != null && intent.getBooleanExtra("debug", false);
    WebView.setWebContentsDebuggingEnabled(debug);
    Log.i(TAG, "WebView remote debugging " + (debug ? "ON" : "off"));
  }

  /** Watches for the two-finger exit hold; all touches still go to the page. */
  @Override
  public boolean dispatchTouchEvent(MotionEvent e) {
    switch (e.getActionMasked()) {
      case MotionEvent.ACTION_POINTER_DOWN:
        if (e.getPointerCount() == 2) {
          for (int i = 0; i < 2; i++) {
            exitIds[i] = e.getPointerId(i);
            exitX[i] = e.getX(i);
            exitY[i] = e.getY(i);
          }
          exitArmed = true;
          handler.removeCallbacks(exitToLauncher);
          handler.postDelayed(exitToLauncher, EXIT_HOLD_MS);
        } else {
          cancelExit(); // 3+ fingers
        }
        break;
      case MotionEvent.ACTION_MOVE:
        if (exitArmed) {
          for (int i = 0; i < 2; i++) {
            int idx = e.findPointerIndex(exitIds[i]);
            if (idx < 0 || Math.hypot(e.getX(idx) - exitX[i], e.getY(idx) - exitY[i]) > EXIT_SLOP_PX) {
              cancelExit();
              break;
            }
          }
        }
        break;
      case MotionEvent.ACTION_POINTER_UP:
      case MotionEvent.ACTION_UP:
      case MotionEvent.ACTION_CANCEL:
        cancelExit();
        break;
      default:
        break;
    }
    return super.dispatchTouchEvent(e);
  }

  private void cancelExit() {
    if (!exitArmed) return;
    exitArmed = false;
    handler.removeCallbacks(exitToLauncher);
  }

  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (hasFocus) hideSystemUi();
  }

  private void hideSystemUi() {
    getWindow().getDecorView().setSystemUiVisibility(
        View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_FULLSCREEN
            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
  }

  @Override
  public void onBackPressed() {
    if (web.canGoBack()) web.goBack();
  }
}
