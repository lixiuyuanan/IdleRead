package com.ldleread.app;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

public class MainActivity extends Activity {
    private static final String APP_HOST = "app.local";
    private static final String AI_URL = "https://api.deepseek.com/chat/completions";
    private static final String TC_URL = "https://transmart.qq.com/api/imt";
    // 免 Key 的公开词典接口:只要 ec(简明)两本词典,响应 1.3KB 左右。
    private static final String YD_URL = "https://dict.youdao.com/jsonapi_s";
    private static final String YD_DICTS = "{\"count\":99,\"dicts\":[[\"ec\",\"simple\"]]}";
    // 更新检查:用户只上传 APK 和说明,不传源码,没有 version.json 可读,只能走 Release 接口。
    // JS 的 app.js 常量区也有一份,仓库改名两边都要改。
    private static final String GH_API = "https://api.github.com/repos/lixiuyuanan/IdleRead/releases/latest";
    private static final String GH_LATEST = "https://github.com/lixiuyuanan/IdleRead/releases/latest";
    private static final String GH_RELEASES = "https://github.com/lixiuyuanan/IdleRead/releases";
    private static final String GH_MIRROR = "https://gh-proxy.com/";
    // 远端维护的镜像清单，App 里点「同步镜像源」就来拉这个（走现有镜像，任何一条能通就行）。
    private static final String MIRROR_LIST_URL =
            "https://github.com/lixiuyuanan/IdleRead/releases/download/mirrors/mirrors.json";
    private static final String APK_MIME = "application/vnd.android.package-archive";
    private static final String APK_PREFS = "apk_download";
    // Google 语音引擎：离线包走 GitHub prerelease，分体安装交给 PackageInstaller。
    private static final String TTS_PKG = "com.google.android.tts";
    private static final String TTS_PACK_DIR = "tts";
    private static final String TTS_INSTALL_ACTION = "com.ldleread.app.TTS_INSTALL_DONE";
    // 多线程下载的分块并发数。镜像单连接只有几十 KB/s，6 条并发实测能到好几倍。
    private static final int DOWNLOAD_THREADS = 6;
    private static final String UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    private static final int LIGHT_BG = Color.rgb(246, 246, 242);
    private static final int DARK_BG = Color.rgb(19, 21, 25);
    private static final int FILE_REQUEST = 1001;
    private static final int WRITE_PERMISSION_REQUEST = 1002;

    private WebView webView;
    private ExecutorService network;
    private ValueCallback<Uri[]> fileCallback;
    private String pendingSaveName;
    private String pendingSaveText;
    private TextToSpeech tts;
    private volatile boolean ttsReady = false;
    private volatile String ttsFail = "";     // 失败原因，ttsStatus() 会把它交给页面
    private int ttsSeq = 0;
    private boolean ttsNeedsRefresh = false;
    private boolean pageReady;
    private Uri pendingImport;
    private String pendingRoute;      // 重启后要让页面落到的位置,目前是 voice
    // 应用内下载安装：id 和期望哈希落 SharedPreferences，进程被杀也能接着校验。
    private long apkDownloadId = -1L;
    private String apkExpectedSha = "";
    private String apkFileName = "";
    private String apkPendingInstall = "";   // 已校验通过、等用户点「安装」的文件名
    private boolean apkInstallArmed = false; // 用户点过「安装」才真装，避免一校验完就自动跳安装器
    private boolean apkPermOpened = false;   // 每轮安装只自动弹一次权限设置页，避免返回后又弹
    private String apkRawUrl = "";           // 不带镜像前缀的原始地址，暂停后恢复要用
    private String[] apkMirrors = null;
    private boolean apkPaused = false;
    private boolean apkHashRetried = false;  // 哈希不一致时只自动换单源重下一次
    private volatile boolean apkPolling = false;  // 下载进度轮询开关
    private BroadcastReceiver apkReceiver;
    // Google 语音引擎离线包
    private long ttsPackId = -1L;
    private String ttsPackSha = "";
    private String ttsPackName = "";
    private String ttsPackPending = "";   // 已下好的引擎包绝对路径，装完删掉
    private boolean ttsPermOpened = false; // 为装引擎去过一次「安装未知应用」设置页
    private String ttsRawUrl = "";
    private String[] ttsMirrors = null;
    private boolean ttsPaused = false;
    private boolean ttsHashRetried = false;
    private volatile boolean ttsPackPolling = false;
    private BroadcastReceiver ttsPackReceiver;
    private BroadcastReceiver ttsInstallReceiver;
    private final ConcurrentHashMap<String, byte[]> importFiles =
            new ConcurrentHashMap<String, byte[]>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        network = Executors.newSingleThreadExecutor();

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setTextZoom(100);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        // Android 10+ 系统深色时,让页面能读到 prefers-color-scheme: dark;页面自己处理配色。
        if (Build.VERSION.SDK_INT >= 29) settings.setAlgorithmicDarkeningAllowed(true);
        settings.setUserAgentString(settings.getUserAgentString() + " XianRead/1.0");

        webView.setBackgroundColor(LIGHT_BG);
        webView.setWebViewClient(new AppWebViewClient());
        webView.setWebChromeClient(new AppWebChromeClient());
        webView.addJavascriptInterface(new Bridge(), "Android");
        // 长按正文由页面自己弹划线菜单,系统那套选词菜单要让位。
        webView.setOnLongClickListener(new View.OnLongClickListener() {
            @Override public boolean onLongClick(View v) { return true; }
        });

        initTts();
        restoreApkDownload();
        registerTtsReceivers();

        applySystemBarTheme(isNightMode());
        webView.loadUrl("https://" + APP_HOST + "/index.html");
        handleViewIntent(getIntent());
        if (getIntent() != null) pendingRoute = getIntent().getStringExtra("open");
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleViewIntent(intent);
    }

    @Override
    protected void onResume() {
        if (webView != null) webView.onResume();
        super.onResume();
        if (ttsNeedsRefresh) {
            ttsNeedsRefresh = false;
            if (tts == null || !tts.isSpeaking()) initTts();
        }
        // 刚从「安装未知应用」设置页回来：权限给了就接着装，没给就留着等下次。
        if (!apkPendingInstall.isEmpty()) retryPendingInstall();
        // 单包直装没有回调：回到前台时看包在不在，装上了就把下好的安装包删掉。
        if (!ttsPackPending.isEmpty() && isPackageInstalled(TTS_PKG)) {
            deleteTtsPack();
            ttsNeedsRefresh = true;
            notifyTts("ok", "语音引擎已安装");
        }
        // 刚从「安装未知应用」设置页回来：别再让用户重下 36 MB，直接接着装。
        if (ttsPermOpened) {
            ttsPermOpened = false;
            if (!ttsPackPending.isEmpty()) {
                File pack = new File(ttsPackPending);
                if (pack.exists()) installTtsSingle(pack);
            }
        }
    }

    private void deleteTtsPack() {
        if (ttsPackPending.isEmpty()) return;
        File file = new File(ttsPackPending);
        if (file.exists()) file.delete();
        ttsPackPending = "";
    }

    @Override
    protected void onPause() {
        if (tts != null) tts.stop();
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (apkReceiver != null) {
            try { unregisterReceiver(apkReceiver); } catch (Exception ignored) { }
            apkReceiver = null;
        }
        ttsPackPolling = false;
        if (ttsPackReceiver != null) {
            try { unregisterReceiver(ttsPackReceiver); } catch (Exception ignored) { }
            ttsPackReceiver = null;
        }
        if (ttsInstallReceiver != null) {
            try { unregisterReceiver(ttsInstallReceiver); } catch (Exception ignored) { }
            ttsInstallReceiver = null;
        }
        if (tts != null) {
            tts.stop();
            tts.shutdown();
            tts = null;
        }
        if (webView != null) {
            webView.removeJavascriptInterface("Android");
            webView.destroy();
            webView = null;
        }
        if (network != null) network.shutdownNow();
        importFiles.clear();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (webView == null) {
            finish();
            return;
        }
        // evaluateJavascript 只在返回字符串时才加引号,布尔 true 会原样变成 "true"。
        // 套一层 String(),让"已处理"永远是 "\"true\""。
        webView.evaluateJavascript("String(window.appBack && window.appBack())",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if (!"\"true\"".equals(value)) finish();
                    }
                });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_REQUEST) return;

        ValueCallback<Uri[]> callback = fileCallback;
        fileCallback = null;
        Uri[] picked = null;
        if (resultCode == RESULT_OK && data != null) {
            Uri uri = data.getData();
            if (uri != null) {
                picked = new Uri[]{uri};
            } else if (data.getClipData() != null && data.getClipData().getItemCount() > 0) {
                picked = new Uri[]{data.getClipData().getItemAt(0).getUri()};
            }
        }
        if (callback != null) callback.onReceiveValue(picked);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (requestCode == WRITE_PERMISSION_REQUEST) {
            String name = pendingSaveName;
            String text = pendingSaveText;
            pendingSaveName = null;
            pendingSaveText = null;
            if (granted && text != null) saveToDownloads(name, text);
            else if (!granted) toast("没有存储权限,导出没完成");
            return;
        }
    }

    /* ---------- 「打开方式」/「分享」送进来的图书 ---------- */

    private void handleViewIntent(Intent intent) {
        if (intent == null) return;
        Uri uri = intent.getData();
        if (uri == null) {
            Object extra = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (extra instanceof Uri) uri = (Uri) extra;
        }
        if (uri == null || uri.toString().startsWith("about:")) return;
        pendingImport = uri;
        takePendingImport();
    }

    // 重启落点只有「语音设置」这一个;别的值直接丢掉,不让外部参数拼进 JS。
    private void deliverRoute() {
        final String route = pendingRoute;
        if (route == null || webView == null) return;
        pendingRoute = null;
        if (!"voice".equals(route)) return;
        webView.evaluateJavascript("window.__nativeRoute && window.__nativeRoute('voice');", null);
    }

    private void takePendingImport() {
        final Uri uri = pendingImport;
        if (uri == null || !pageReady || webView == null || network == null) return;
        pendingImport = null;
        network.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    final byte[] bytes = readUri(uri);
                    if (bytes.length == 0) {
                        toast("这个文件是空的");
                        return;
                    }
                    if (bytes.length > 40 * 1024 * 1024) {
                        toast("文件超过 40 MB,导不进书架");
                        return;
                    }
                    final String token = Long.toHexString(System.nanoTime());
                    importFiles.put(token, bytes);
                    final String script = "window.__nativeImport("
                            + JSONObject.quote(displayName(uri)) + ","
                            + JSONObject.quote("/import/" + token) + ")";
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            if (webView != null) webView.evaluateJavascript(script, null);
                        }
                    });
                } catch (Exception e) {
                    toast("读不到这个文件:" + message(e));
                }
            }
        });
    }

    private byte[] readUri(Uri uri) throws Exception {
        InputStream input = getContentResolver().openInputStream(uri);
        if (input == null) throw new Exception("系统没有给出可读的内容");
        try {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[16384];
            int read;
            while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
            return output.toByteArray();
        } finally {
            input.close();
        }
    }

    private String displayName(Uri uri) {
        String fallback = uri.getLastPathSegment();
        if (fallback == null || fallback.contains("/")) fallback = "book.txt";
        if (!"content".equals(uri.getScheme())) return fallback;
        try {
            android.database.Cursor cursor = getContentResolver().query(uri,
                    new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
            try {
                if (cursor != null && cursor.moveToFirst()) {
                    int column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (column >= 0) {
                        String name = cursor.getString(column);
                        if (name != null && !name.trim().isEmpty()) return new File(name).getName();
                    }
                }
            } finally {
                if (cursor != null) cursor.close();
            }
        } catch (Exception e) {
            // 拿不到显示名就用路径里最后一段,不影响导入
        }
        return fallback;
    }

    private boolean isNightMode() {
        int mode = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return mode == Configuration.UI_MODE_NIGHT_YES;
    }

    private void applySystemBarTheme(boolean dark) {
        int bg = dark ? DARK_BG : LIGHT_BG;
        getWindow().setStatusBarColor(bg);
        getWindow().setNavigationBarColor(bg);
        if (webView != null) webView.setBackgroundColor(bg);

        View decor = getWindow().getDecorView();
        int flags = decor.getSystemUiVisibility();
        if (!dark) flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        else flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if (Build.VERSION.SDK_INT >= 27) {
            if (!dark) flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            else flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        decor.setSystemUiVisibility(flags);
    }

    private WebResourceResponse loadAsset(String path) {
        String relative = path == null || path.isEmpty() || "/".equals(path)
                ? "index.html" : Uri.decode(path.substring(1));
        if (relative.contains("..") || relative.startsWith("/")) {
            return errorResponse(403, "禁止访问");
        }
        // /import/<token>:「打开方式」送进来的文件,取一次就作废
        if (relative.startsWith("import/")) {
            byte[] bytes = importFiles.remove(relative.substring(7));
            if (bytes == null) return errorResponse(404, "文件已失效");
            HashMap<String, String> headers = new HashMap<String, String>();
            headers.put("Cache-Control", "no-store");
            return new WebResourceResponse("application/octet-stream", null, 200, "OK", headers,
                    new java.io.ByteArrayInputStream(bytes));
        }

        try {
            InputStream input = getAssets().open("www/" + relative);
            String mime = mimeFor(relative);
            HashMap<String, String> headers = new HashMap<String, String>();
            headers.put("Cache-Control", "no-store");
            return new WebResourceResponse(mime, charsetFor(mime), 200, "OK", headers, input);
        } catch (Exception e) {
            return errorResponse(404, "找不到文件");
        }
    }

    private WebResourceResponse errorResponse(int status, String message) {
        HashMap<String, String> headers = new HashMap<String, String>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "UTF-8", status, message, headers,
                new java.io.ByteArrayInputStream(message.getBytes()));
    }

    private String mimeFor(String path) {
        String lower = path.toLowerCase(Locale.US);
        if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".js")) return "application/javascript";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    private String charsetFor(String mime) {
        if ("text/html".equals(mime) || "text/css".equals(mime)
                || "application/javascript".equals(mime) || "application/json".equals(mime)) {
            return "UTF-8";
        }
        return null;
    }

    private void saveToDownloads(String rawName, String text) {
        String name = rawName == null || rawName.trim().isEmpty() ? "ldleRead.json" : new File(rawName).getName();
        if (!name.toLowerCase(Locale.US).endsWith(".json")) name = name + ".json";
        byte[] bytes = text.getBytes();

        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, name);
                values.put(MediaStore.Downloads.MIME_TYPE, "application/json");
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) throw new Exception("系统没有给出保存位置");

                OutputStream output = getContentResolver().openOutputStream(uri);
                output.write(bytes);
                output.close();
                values.clear();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                getContentResolver().update(uri, values, null, null);
            } else {
                if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                        != PackageManager.PERMISSION_GRANTED) {
                    pendingSaveName = name;
                    pendingSaveText = text;
                    requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE},
                            WRITE_PERMISSION_REQUEST);
                    return;
                }
                File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                if (!dir.exists() && !dir.mkdirs()) throw new Exception("无法创建下载目录");
                File file = new File(dir, name);
                FileOutputStream output = new FileOutputStream(file);
                output.write(bytes);
                output.close();
            }
            toast("已保存到「下载」/" + name);
        } catch (Exception e) {
            toast("保存失败:" + message(e));
        }
    }

    private String requestDeepSeek(String body, String key) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(AI_URL);
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(30000);
            connection.setReadTimeout(180000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("Authorization", "Bearer " + key);

            OutputStream output = connection.getOutputStream();
            output.write(body.getBytes("UTF-8"));
            output.flush();
            output.close();

            int code = connection.getResponseCode();
            InputStream input = code >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String raw = readAll(input);
            if (code < 200 || code >= 300) return errorJson("接口返回 " + code + " " + trim(raw));

            JSONObject object = new JSONObject(raw);
            JSONArray choices = object.optJSONArray("choices");
            if (choices == null || choices.length() == 0) return errorJson("接口没有返回内容");
            JSONObject message = choices.getJSONObject(0).optJSONObject("message");
            String content = message == null ? null : message.optString("content");
            if (content == null || content.trim().isEmpty()) return errorJson("接口没有返回内容");

            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("content", content);
            return result.toString();
        } catch (Exception e) {
            return errorJson(message(e));
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private String requestTencent(String body) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(TC_URL);
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(20000);
            connection.setReadTimeout(90000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("Origin", "https://transmart.qq.com");
            connection.setRequestProperty("Referer", "https://transmart.qq.com/zh-CN/index");
            connection.setRequestProperty("User-Agent", UA);

            OutputStream output = connection.getOutputStream();
            output.write(body.getBytes("UTF-8"));
            output.flush();
            output.close();

            int code = connection.getResponseCode();
            InputStream input = code >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String raw = readAll(input);
            if (code < 200 || code >= 300) {
                String preview = raw == null ? "" : raw.trim();
                if (preview.length() > 200) preview = preview.substring(0, 200) + "…";
                return errorJson("接口返回 " + code + " " + preview);
            }

            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("content", raw);
            return result.toString();
        } catch (Exception e) {
            return errorJson(message(e));
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    // 有道公开词典:GET 一个词,回来 {phon, trs:[{pos, tran}]}。
    // 接口不返回 CORS 头,只能在原生这边取,JS 侧直接 fetch 会被 WebView 拦掉。
    private String requestYoudao(String word) {
        HttpURLConnection connection = null;
        try {
            String q = URLEncoder.encode(word == null ? "" : word.trim(), "UTF-8").replace("+", "%20");
            if (q.isEmpty()) return errorJson("要查的词是空的");
            URL url = new URL(YD_URL + "?doctype=json&jsonversion=4&q=" + q
                    + "&dicts=" + URLEncoder.encode(YD_DICTS, "UTF-8"));
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(30000);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Referer", "https://dict.youdao.com/");
            connection.setRequestProperty("User-Agent", UA);

            int code = connection.getResponseCode();
            InputStream input = code >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String raw = readAll(input);
            if (code < 200 || code >= 300) return errorJson("词典接口返回 " + code + " " + trim(raw));

            JSONObject object = new JSONObject(raw);
            JSONObject ec = object.optJSONObject("ec");
            JSONObject entry = null;
            if (ec != null) {
                Object w = ec.opt("word");
                if (w instanceof JSONObject) entry = (JSONObject) w;
                else if (w instanceof JSONArray && ((JSONArray) w).length() > 0) {
                    entry = ((JSONArray) w).optJSONObject(0);
                }
            }
            if (entry == null) return errorJson("词典里没收录这个词");

            JSONArray src = entry.optJSONArray("trs");
            JSONArray trs = new JSONArray();
            String phon = nz(entry.optString("ukphone", ""));
            if (phon.isEmpty()) phon = nz(entry.optString("usphone", ""));
            if (phon.isEmpty()) {
                JSONObject simple = object.optJSONObject("simple");
                JSONArray sw = simple == null ? null : simple.optJSONArray("word");
                JSONObject s0 = sw == null ? null : sw.optJSONObject(0);
                if (s0 != null) phon = nz(s0.optString("ukphone", ""));
            }
            for (int i = 0; src != null && i < src.length(); i++) {
                JSONObject one = src.optJSONObject(i);
                if (one == null) continue;
                String tran = nz(one.optString("tran", ""));
                if (tran.isEmpty()) continue;
                JSONObject line = new JSONObject();
                line.put("pos", nz(one.optString("pos", "")));
                line.put("tran", tran);
                trs.put(line);
            }
            if (trs.length() == 0) return errorJson("词典没给出释义");

            JSONObject body = new JSONObject();
            body.put("phon", phon);
            body.put("trs", trs);
            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("content", body.toString());
            return result.toString();
        } catch (Exception e) {
            return errorJson(message(e));
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String nz(String s) {
        return s == null ? "" : s.trim();
    }

    /* ---------- 检查更新 ---------- */

    private void deliverUpdateResult(final String id, final String payload) {
        if (webView == null) return;
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (webView == null) return;
                String script = "window.__updateResult(" + JSONObject.quote(id) + ","
                        + JSONObject.quote(payload) + ")";
                webView.evaluateJavascript(script, null);
            }
        });
    }

    // 主路径走 Release API;失败退到 releases/latest 的重定向取 tag,再失败试镜像前缀。
    // 重定向兜底拿不到 assets,只能按命名规则拼安装包地址,可能 404,所以只做最后兜底。
    private String requestUpdate() {
        String[] err = new String[]{""};
        String r = updateFromApi(GH_API, err);
        if (r == null) r = updateFromApi(GH_MIRROR + GH_API, err);
        if (r != null) return r;

        String tag = tagFromRedirect();
        if (tag != null && !tag.isEmpty()) {
            String version = tag.startsWith("v") || tag.startsWith("V") ? tag.substring(1) : tag;
            if (!version.isEmpty()) {
                try {
                    JSONObject result = new JSONObject();
                    result.put("ok", true);
                    result.put("version", version);
                    result.put("notes", "");
                    result.put("url", GH_RELEASES + "/download/" + tag
                            + "/IdleRead-" + version + ".apk");
                    return result.toString();
                } catch (Exception ignored) { }
            }
        }
        return errorJson("检查更新失败" + (err[0].isEmpty() ? ",请稍后重试" : ":" + err[0]));
    }

    // 拉一次 Release API 并解析。成功返回 {ok:true,...};失败返回 null,原因写进 err[0]。
    private String updateFromApi(String url, String[] err) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(12000);
            connection.setRequestProperty("Accept", "application/vnd.github+json");
            connection.setRequestProperty("User-Agent", UA);

            int code = connection.getResponseCode();
            InputStream input = code >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String raw = readAll(input);
            if (code < 200 || code >= 300) {
                err[0] = "接口返回 " + code + " " + trim(raw);
                return null;
            }
            JSONObject object = new JSONObject(raw);
            String tag = nz(object.optString("tag_name", ""));
            if (tag.isEmpty()) {
                err[0] = "接口没返回版本号";
                return null;
            }
            String version = tag.startsWith("v") || tag.startsWith("V") ? tag.substring(1) : tag;
            JSONObject apk = pickApk(object.optJSONArray("assets"));
            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("version", version);
            result.put("notes", nz(object.optString("body", "")));
            result.put("url", apk == null ? "" : nz(apk.optString("browser_download_url", "")));
            // digest 形如 "sha256:xxxx";给页面显示和比对用,重定向兜底拿不到就留空。
            result.put("sha", apk == null ? "" : nz(apk.optString("digest", "")));
            result.put("size", apk == null ? 0 : apk.optLong("size", 0));
            return result.toString();
        } catch (Exception e) {
            err[0] = message(e);
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    // 优先 IdleRead-版本号.apk(v1.6.0 起的命名),没有再退到任意 .apk(v1.5.8 叫 IdleRead.apk)。
    private static JSONObject pickApk(JSONArray assets) {
        if (assets == null) return null;
        JSONObject any = null;
        for (int i = 0; i < assets.length(); i++) {
            JSONObject a = assets.optJSONObject(i);
            if (a == null) continue;
            String name = nz(a.optString("name", ""));
            if (name.isEmpty()) continue;
            if (name.matches("(?i)idleread-.*\\.apk")) return a;
            if (any == null && name.matches("(?i).*\\.apk")) any = a;
        }
        return any;
    }

    // releases/latest 会 302 到 /releases/tag/<tag>;不许自动跟随,自己读 Location。
    private String tagFromRedirect() {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(GH_LATEST).openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(12000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("User-Agent", UA);
            int code = connection.getResponseCode();
            if (code < 300 || code >= 400) return null;
            String loc = connection.getHeaderField("Location");
            if (loc == null || loc.isEmpty()) return null;
            int p = loc.lastIndexOf("/tag/");
            if (p < 0) return null;
            String tag = loc.substring(p + 5);
            int cut = tag.indexOf('?');
            if (cut >= 0) tag = tag.substring(0, cut);
            cut = tag.indexOf('#');
            if (cut >= 0) tag = tag.substring(0, cut);
            return nz(tag);
        } catch (Exception e) {
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /* ---------- 应用内下载 → 校验 SHA-256 → 拉起安装器 (1.6.4) ---------- */

    private void startApkDownload(String rawUrl, String name, String sha, String[] mirrors,
                                  boolean resume, final boolean single) {
        try {
            File dir = ApkProvider.dir(this);
            File target = new File(dir, name);
            if (!resume) cleanOldApks(dir, name);

            apkRawUrl = rawUrl;
            apkMirrors = mirrors;
            apkFileName = name;
            apkExpectedSha = normalizeSha(sha);
            apkDownloadId = 0L;
            apkInstallArmed = false;
            apkPaused = false;
            saveApkState();
            notifyApk("downloading", resume ? "正在接着下载" : "正在测速选源");
            if (!resume) toast("开始下载，完成后自动校验");
            keepScreenOn(true);

            RangeDownloader.start(rawUrl, mirrors, target, resume, single,
                    new RangeDownloader.Listener() {
                @Override public void onProbe(int alive, String best) {
                    if (alive <= 0) return;
                    notifyApk("downloading", "已选 " + alive + " 个源（最快 " + best + "）");
                }

                @Override public void onProgress(long done, long total) {
                    notifyApkProgress(done, total);
                }

                @Override public void onPause(long done, long total) {
                    apkPaused = true;
                    keepScreenOn(false);
                    notifyApk("paused", "已暂停，已下 " + percent(done, total) + "%，可以接着下");
                }

                @Override public void onDone(File file) {
                    keepScreenOn(false);
                    onApkFileReady(file);
                }

                @Override public void onError(String text) {
                    keepScreenOn(false);
                    clearApkState();
                    notifyApk("fail", "下载失败：" + text);
                    toast("下载失败:" + text);
                }
            });
        } catch (Exception e) {
            keepScreenOn(false);
            apkDownloadId = -1L;
            clearApkState();
            notifyApk("fail", "下载失败：" + message(e));
            toast("下载失败:" + message(e));
        }
    }

    private static int percent(long done, long total) {
        if (total <= 0) return 0;
        long value = done * 100L / total;
        if (value < 0) value = 0;
        if (value > 100) value = 100;
        return (int) value;
    }

    // 下载期间别让屏幕熄掉——熄屏后系统会降频，下载会慢一大截甚至断掉。
    private void keepScreenOn(final boolean on) {
        runOnUiThread(new Runnable() {
            @Override public void run() {
                if (on) {
                    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            }
        });
    }

    // 只留最新一个包，别让历史版本堆在应用目录里。
    private static void cleanOldApks(File dir, String keep) {
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File file : files) {
            if (!file.isFile()) continue;
            if (!file.getName().toLowerCase(Locale.US).endsWith(".apk")) continue;
            if (file.getName().equals(keep)) continue;
            file.delete();
        }
    }

    private SharedPreferences apkPrefs() {
        return getSharedPreferences(APK_PREFS, MODE_PRIVATE);
    }

    private void saveApkState() {
        apkPrefs().edit()
                .putLong("id", apkDownloadId)
                .putString("sha", apkExpectedSha)
                .putString("name", apkFileName)
                .apply();
    }

    private void clearApkState() {
        apkExpectedSha = "";
        apkFileName = "";
        apkDownloadId = -1L;
        apkPrefs().edit().remove("id").remove("sha").remove("name").apply();
    }

    // 校验通过：文件留着等用户点「安装」，并把可装的文件名持久化（重开 App 也能恢复按钮）。
    private void markApkReady(String name) {
        apkPendingInstall = name;
        apkInstallArmed = false;
        apkExpectedSha = "";
        apkFileName = "";
        apkDownloadId = -1L;
        apkPrefs().edit()
                .remove("id").remove("sha").remove("name")
                .putString("ready", name)
                .apply();
    }

    private void restoreApkDownload() {
        SharedPreferences prefs = apkPrefs();
        apkDownloadId = prefs.getLong("id", -1L);
        apkExpectedSha = prefs.getString("sha", "");
        apkFileName = prefs.getString("name", "");
        String ready = prefs.getString("ready", "");
        if (!ready.isEmpty()) {
            File file = new File(ApkProvider.dir(this), ready);
            apkPendingInstall = file.exists() ? ready : "";
        }
    }

    private void onApkFileReady(final File file) {
        if (network == null || network.isShutdown()) return;
        network.execute(new Runnable() {
            @Override public void run() {
                if (!file.exists()) {
                    clearApkState();
                    notifyApk("fail", "安装包不见了，请重新下载");
                    return;
                }
                notifyApk("verifying", "正在校验安装包");
                String actual;
                try {
                    actual = sha256(file);
                } catch (Exception e) {
                    notifyApk("fail", "校验失败：" + message(e));
                    return;
                }
                String expect = apkExpectedSha;
                if (!expect.isEmpty() && !expect.equalsIgnoreCase(actual)) {
                    // 多源拼出来的包哈希不对：先怀疑某个镜像缓存了别的版本，
                    // 自动换「单一源」重下一遍，别急着让用户去换源。
                    if (!apkHashRetried && apkMirrors != null && apkMirrors.length > 1) {
                        apkHashRetried = true;
                        file.delete();
                        final String raw = apkRawUrl;
                        final String[] mirrors = apkMirrors;
                        final String name = file.getName();
                        runOnUiThread(new Runnable() {
                            @Override public void run() {
                                notifyApk("verifying", "校验不一致，换单一源重下一遍");
                                startApkDownload(raw, name, expect, mirrors, false, true);
                            }
                        });
                        return;
                    }
                    file.delete();
                    clearApkState();
                    // 镜像被篡改或下坏了：删掉，让用户换一个源重下，绝不装。
                    notifyApk("badhash", "哈希值不同，可能存在风险，已删除，请换源下载");
                    toast("哈希值不同，可能存在风险，已删除，请换源下载");
                    return;
                }
                apkHashRetried = false;
                // 校验通过不自动装：进度条变绿 + 页面出现「安装」按钮，由用户点。
                markApkReady(file.getName());
                notifyApk("ok", expect.isEmpty()
                        ? "下载完成（这次没拿到官方哈希，建议自行核对）"
                        : "SHA-256 校验通过");
            }
        });
    }

    // 只有用户真点了「安装」才走这里（apkInstallArmed）。
    // 缺「安装未知应用」权限就只弹一次设置页，返回后 onResume 接着装。
    private void retryPendingInstall() {
        if (!apkInstallArmed || apkPendingInstall.isEmpty()) return;
        if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            if (!apkPermOpened) {
                apkPermOpened = true;
                toast("请在设置里允许「安装未知应用」，返回后会自动继续");
                notifyApk("permission", "需要允许「安装未知应用」");
                try {
                    startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:" + getPackageName())));
                } catch (Exception e) {
                    toast("请到系统设置里手动允许安装");
                }
            }
            return;
        }
        File file = new File(ApkProvider.dir(this), apkPendingInstall);
        if (!file.exists()) {
            apkPendingInstall = "";
            apkInstallArmed = false;
            apkPrefs().edit().remove("ready").apply();
            notifyApk("fail", "安装包不见了，请重新下载");
            return;
        }
        apkPendingInstall = "";
        apkInstallArmed = false;
        apkPrefs().edit().remove("ready").apply();
        installApk(file);
    }

    private void installApk(File file) {
        try {
            Uri uri = ApkProvider.uriFor(this, file);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, APK_MIME);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
            notifyApk("installing", "已打开安装界面");
        } catch (Exception e) {
            toast("打不开安装界面：" + message(e));
            notifyApk("fail", "打不开安装界面，请到文件管理器手动安装");
        }
    }

    private void notifyApk(final String state, final String text) {
        if (webView == null) return;
        final String payload = text == null ? "" : text;
        runOnUiThread(new Runnable() {
            @Override public void run() {
                if (webView == null) return;
                webView.evaluateJavascript("window.__apkResult && window.__apkResult("
                        + JSONObject.quote(state) + "," + JSONObject.quote(payload) + ")", null);
            }
        });
    }

    private void notifyApkProgress(final long done, final long total) {
        if (webView == null) return;
        final long d = done < 0 ? 0 : done;
        final long t = total;
        runOnUiThread(new Runnable() {
            @Override public void run() {
                if (webView == null) return;
                webView.evaluateJavascript("window.__apkProgress && window.__apkProgress("
                        + d + "," + t + ")", null);
            }
        });
    }

    private static String normalizeSha(String raw) {
        String value = nz(raw).toLowerCase(Locale.US);
        if (value.startsWith("sha256:")) value = value.substring(7);
        if (value.length() != 64) return "";
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return "";
        }
        return value;
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        FileInputStream input = new FileInputStream(file);
        try {
            byte[] buffer = new byte[16384];
            int read;
            while ((read = input.read(buffer)) != -1) digest.update(buffer, 0, read);
        } finally {
            input.close();
        }
        byte[] out = digest.digest();
        StringBuilder builder = new StringBuilder(out.length * 2);
        for (byte b : out) {
            builder.append(Character.forDigit((b >> 4) & 0xf, 16));
            builder.append(Character.forDigit(b & 0xf, 16));
        }
        return builder.toString();
    }

    /* ---------- Google 语音引擎离线包：下载 → 校验 → 分体安装 (1.6.6) ---------- */

    // 引擎包和 App 升级包放同一个目录：ApkProvider 只暴露这一个目录，
    // 单包直装要靠它把文件 URI 递给系统安装器。
    private File ttsPackDir() {
        File dir = ApkProvider.dir(this);
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    private static void clearFiles(File dir, final String suffix) {
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File file : files) {
            if (file.isFile() && file.getName().toLowerCase(Locale.US).endsWith(suffix)) {
                file.delete();
            }
        }
    }

    private void startTtsPackDownload(String rawUrl, String name, String sha, String[] mirrors,
                                      boolean resume, final boolean single) {
        try {
            File dir = ttsPackDir();
            File target = new File(dir, name);
            if (!resume) {
                clearFiles(dir, ".apks");
                clearFiles(new File(dir, "splits"), ".apk");
                if (target.exists()) target.delete();
            }

            ttsRawUrl = rawUrl;
            ttsMirrors = mirrors;
            ttsPackName = name;
            ttsPackSha = normalizeSha(sha);
            ttsPackId = 0L;
            ttsPaused = false;
            notifyTts("downloading", resume ? "正在接着下载" : "正在测速选源");
            keepScreenOn(true);
            RangeDownloader.start(rawUrl, mirrors, target, resume, single,
                    new RangeDownloader.Listener() {
                @Override public void onProbe(int alive, String best) {
                    if (alive <= 0) return;
                    notifyTts("downloading", "已选 " + alive + " 个源（最快 " + best + "）");
                }

                @Override public void onProgress(long done, long total) {
                    notifyTtsProgress(done, total);
                }

                @Override public void onPause(long done, long total) {
                    ttsPaused = true;
                    keepScreenOn(false);
                    notifyTts("paused", "已暂停，已下 " + percent(done, total) + "%，可以接着下");
                }

                @Override public void onDone(File file) {
                    keepScreenOn(false);
                    onTtsPackFileReady(file);
                }

                @Override public void onError(String text) {
                    keepScreenOn(false);
                    notifyTts("fail", "下载失败：" + text);
                }
            });
        } catch (Exception e) {
            keepScreenOn(false);
            ttsPackId = -1L;
            notifyTts("fail", "下载失败：" + message(e));
        }
    }

    private void onTtsPackFileReady(final File file) {
        if (network == null || network.isShutdown()) return;
        network.execute(new Runnable() {
            @Override public void run() {
                if (!file.exists()) {
                    notifyTts("fail", "下载的文件不见了，请重试");
                    return;
                }
                notifyTts("verifying", "正在校验安装包");
                try {
                    String actual = sha256(file);
                    if (!ttsPackSha.isEmpty() && !ttsPackSha.equalsIgnoreCase(actual)) {
                        // 多源拼包校验不过：先用单一源重下一遍，排除某个镜像缓存旧版本的可能。
                        if (!ttsHashRetried && ttsMirrors != null && ttsMirrors.length > 1) {
                            ttsHashRetried = true;
                            final String raw = ttsRawUrl;
                            final String[] mirrors = ttsMirrors;
                            final String name = file.getName();
                            final String expect = ttsPackSha;
                            file.delete();
                            runOnUiThread(new Runnable() {
                                @Override public void run() {
                                    notifyTts("verifying", "校验不一致，换单一源重下一遍");
                                    startTtsPackDownload(raw, name, expect, mirrors, false, true);
                                }
                            });
                            return;
                        }
                        file.delete();
                        notifyTts("badhash", "哈希值不同，可能存在风险，已删除，请重试");
                        return;
                    }
                    ttsHashRetried = false;
                } catch (Exception e) {
                    notifyTts("fail", "校验失败：" + message(e));
                    return;
                }
                String lower = file.getName().toLowerCase(Locale.US);
                if (lower.endsWith(".apks")) {
                    // 分体包：MIUI 会拦（必须关 MIUI 优化），只在非小米机型上才用这条路。
                    notifyTts("extracting", "正在解包");
                    List<File> splits;
                    try {
                        splits = extractSplits(file, new File(ttsPackDir(), "splits"));
                        file.delete();
                    } catch (Exception e) {
                        notifyTts("fail", "解包失败：" + message(e));
                        return;
                    }
                    if (splits.isEmpty()) {
                        notifyTts("fail", "这个包里没有安装文件");
                        return;
                    }
                    installTtsSplits(splits);
                    return;
                }
                // 单包（universal）：直接走普通安装器，MIUI 也能装。
                notifyTts("installing", "正在安装语音引擎");
                ttsPackPending = file.getAbsolutePath();
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        installTtsSingle(file);
                    }
                });
            }
        });
    }

    // 单包直装：和 App 自身升级同一条路（ApkProvider + ACTION_VIEW），MIUI 上验证过可用。
    private void installTtsSingle(File file) {
        if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            ttsPermOpened = true;
            notifyTts("permission", "需要允许「安装未知应用」");
            openInstallSettings();
            return;
        }
        try {
            Uri uri = ApkProvider.uriFor(this, file);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, APK_MIME);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
            ttsNeedsRefresh = true;
        } catch (Exception e) {
            notifyTts("fail", "打不开安装界面：" + message(e));
        }
    }

    // .apks 就是个装着多个 split APK 的 zip，逐个解到 splits/ 下。
    private List<File> extractSplits(File pack, File dir) throws Exception {
        if (!dir.exists()) dir.mkdirs();
        clearFiles(dir, ".apk");
        List<File> out = new ArrayList<File>();
        ZipInputStream zip = new ZipInputStream(new FileInputStream(pack));
        try {
            byte[] buffer = new byte[65536];
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                if (!entry.isDirectory()) {
                    String entryName = entry.getName();
                    if (entryName.toLowerCase(Locale.US).endsWith(".apk")) {
                        File target = new File(dir, new File(entryName).getName());
                        FileOutputStream fos = new FileOutputStream(target);
                        try {
                            int read;
                            while ((read = zip.read(buffer)) != -1) fos.write(buffer, 0, read);
                        } finally {
                            fos.close();
                        }
                        out.add(target);
                    }
                }
                zip.closeEntry();
            }
        } finally {
            zip.close();
        }
        return out;
    }

    // 分体安装必须一个会话写完所有 split，不能一个一个装。
    private void installTtsSplits(final List<File> splits) {
        notifyTts("installing", "正在安装语音引擎");
        network.execute(new Runnable() {
            @Override public void run() {
                PackageInstaller installer = getPackageManager().getPackageInstaller();
                PackageInstaller.Session session = null;
                try {
                    PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(
                            PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                    params.setAppPackageName(TTS_PKG);
                    int sessionId = installer.createSession(params);
                    session = installer.openSession(sessionId);
                    for (File apk : splits) {
                        InputStream input = new FileInputStream(apk);
                        try {
                            OutputStream output = session.openWrite(apk.getName(), 0, apk.length());
                            try {
                                byte[] buffer = new byte[65536];
                                int read;
                                while ((read = input.read(buffer)) != -1) {
                                    output.write(buffer, 0, read);
                                }
                                session.fsync(output);
                            } finally {
                                output.close();
                            }
                        } finally {
                            input.close();
                        }
                    }
                    Intent callback = new Intent(TTS_INSTALL_ACTION).setPackage(getPackageName());
                    int flags = PendingIntent.FLAG_UPDATE_CURRENT;
                    if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE;
                    PendingIntent pending = PendingIntent.getBroadcast(
                            MainActivity.this, sessionId, callback, flags);
                    session.commit(pending.getIntentSender());
                } catch (Exception e) {
                    notifyTts("fail", "安装失败：" + message(e));
                } finally {
                    if (session != null) {
                        try { session.close(); } catch (Exception ignored) { }
                    }
                }
            }
        });
    }

    private void registerTtsReceivers() {
        if (ttsInstallReceiver == null) {
            ttsInstallReceiver = new BroadcastReceiver() {
                @Override public void onReceive(Context context, Intent intent) {
                    onTtsInstallResult(intent);
                }
            };
            IntentFilter filter = new IntentFilter(TTS_INSTALL_ACTION);
            if (Build.VERSION.SDK_INT >= 33) {
                registerReceiver(ttsInstallReceiver, filter, Context.RECEIVER_EXPORTED);
            } else {
                registerReceiver(ttsInstallReceiver, filter);
            }
        }
    }

    private void onTtsInstallResult(Intent intent) {
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS,
                PackageInstaller.STATUS_FAILURE);
        String msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        if (status == PackageInstaller.STATUS_SUCCESS) {
            ttsNeedsRefresh = true;
            deleteTtsPack();
            notifyTts("ok", "语音引擎已安装");
            toast("语音引擎已安装，去选为首选引擎");
            return;
        }
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = (Intent) intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) {
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try { startActivity(confirm); } catch (Exception ignored) { }
            }
            notifyTts("confirm", "请在系统弹窗里点「安装」");
            return;
        }
        notifyTts("fail", "安装失败"
                + (msg == null || msg.trim().isEmpty() ? "（代码 " + status + "）" : "：" + msg));
    }

    private void notifyTts(final String state, final String text) {
        if (webView == null) return;
        final String payload = text == null ? "" : text;
        runOnUiThread(new Runnable() {
            @Override public void run() {
                if (webView == null) return;
                webView.evaluateJavascript("window.__ttsPackResult && window.__ttsPackResult("
                        + JSONObject.quote(state) + "," + JSONObject.quote(payload) + ")", null);
            }
        });
    }

    private void notifyTtsProgress(final long done, final long total) {
        if (webView == null) return;
        final long d = done < 0 ? 0 : done;
        final long t = total;
        runOnUiThread(new Runnable() {
            @Override public void run() {
                if (webView == null) return;
                webView.evaluateJavascript("window.__ttsPackProgress && window.__ttsPackProgress("
                        + d + "," + t + ")", null);
            }
        });
    }

    private boolean isPackageInstalled(String pkg) {
        try {
            getPackageManager().getPackageInfo(pkg, 0);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private void openInstallSettings() {
        try {
            startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getPackageName())));
        } catch (Exception e) {
            toast("请到系统设置里手动允许安装");
        }
    }

    // 只认发布相关主机,别让页面拿这个口子往任意地址塞下载。
    private static boolean isApkHost(String host) {
        return host.equals("github.com")
                || host.equals("objects.githubusercontent.com")
                || host.equals("release-assets.githubusercontent.com")
                || host.equals("gh-proxy.com")
                || host.equals("ghproxy.net");
    }

    /**
     * 把页面传来的镜像前缀数组洗干净：只收 https、限个数、去掉带空白或奇怪字符的。
     *
     * <p>镜像列表可以远程同步，所以不能盲信——但真正兜底的是下载完的 SHA-256 校验，
     * 这里只做基本的形状检查，避免明显跑偏的地址拖慢测速。</p>
     */
    private static String[] sanitizeMirrors(String json) {
        List<String> out = new ArrayList<String>();
        try {
            String text = json == null ? "" : json.trim();
            JSONArray array = new JSONArray(text.isEmpty() ? "[]" : text);
            for (int i = 0; i < array.length() && out.size() < 16; i++) {
                String prefix = nz(array.optString(i, "")).trim();
                if (prefix.isEmpty()) continue;
                if (!prefix.toLowerCase(Locale.US).startsWith("https://")) continue;
                if (prefix.length() > 120) continue;
                boolean dirty = false;
                for (int k = 0; k < prefix.length(); k++) {
                    char ch = prefix.charAt(k);
                    if (ch <= ' ' || ch == '"' || ch == '\\' || ch == '<' || ch == '>') {
                        dirty = true;
                        break;
                    }
                }
                if (dirty) continue;
                if (!prefix.endsWith("/")) prefix = prefix + "/";
                out.add(prefix);
            }
        } catch (Exception ignored) { }
        // 直连永远垫底：能直连 GitHub 的时候它经常比镜像还快。
        out.add("");
        return out.toArray(new String[out.size()]);
    }

    /* ---------- 镜像源同步：用现有镜像去拉远端的 mirrors.json ---------- */

    private String fetchMirrorList(String[] prefixes) {
        ExecutorService pool = Executors.newFixedThreadPool(
                Math.min(6, Math.max(1, prefixes.length)));
        List<Future<String>> futures = new ArrayList<Future<String>>();
        for (final String prefix : prefixes) {
            futures.add(pool.submit(new Callable<String>() {
                @Override public String call() {
                    try {
                        return httpText(prefix + MIRROR_LIST_URL);
                    } catch (Exception e) {
                        return null;
                    }
                }
            }));
        }
        long deadline = System.currentTimeMillis() + 15000L;
        String result = null;
        for (Future<String> future : futures) {
            long left = deadline - System.currentTimeMillis();
            if (left <= 0) break;
            try {
                String text = future.get(left, TimeUnit.MILLISECONDS);
                if (text != null && text.trim().startsWith("{")) {
                    result = text;
                    break;
                }
            } catch (Exception ignored) { }
        }
        pool.shutdownNow();
        return result;
    }

    private String httpText(String link) throws Exception {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(link).openConnection();
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(12000);
            connection.setRequestProperty("User-Agent", UA);
            connection.setRequestProperty("Cache-Control", "no-cache");
            if (connection.getResponseCode() != 200) return null;
            InputStream input = connection.getInputStream();
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            try {
                byte[] chunk = new byte[8192];
                int read;
                int total = 0;
                while ((read = input.read(chunk)) != -1) {
                    total += read;
                    if (total > 256 * 1024) break;   // 镜像列表不该这么大
                    buffer.write(chunk, 0, read);
                }
            } finally {
                input.close();
            }
            return new String(buffer.toByteArray(), "UTF-8");
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void notifyMirrorSync(final String json, final String error) {
        if (webView == null) return;
        runOnUiThread(new Runnable() {
            @Override public void run() {
                if (webView == null) return;
                webView.evaluateJavascript("window.__mirrorSync && window.__mirrorSync("
                        + JSONObject.quote(json == null ? "" : json) + ","
                        + JSONObject.quote(error == null ? "" : error) + ")", null);
            }
        });
    }

    private void notifyMirrorCheck(final String json, final String error) {
        if (webView == null) return;
        runOnUiThread(new Runnable() {
            @Override public void run() {
                if (webView == null) return;
                webView.evaluateJavascript("window.__mirrorCheck && window.__mirrorCheck("
                        + JSONObject.quote(json == null ? "" : json) + ","
                        + JSONObject.quote(error == null ? "" : error) + ")", null);
            }
        });
    }

    private void deliverTcResult(final String id, final String payload) {
        if (webView == null) return;
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (webView == null) return;
                String script = "window.__tcResult(" + JSONObject.quote(id) + ","
                        + JSONObject.quote(payload) + ")";
                webView.evaluateJavascript(script, null);
            }
        });
    }

    private void deliverDictResult(final String id, final String payload) {
        if (webView == null) return;
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (webView == null) return;
                String script = "window.__dictResult(" + JSONObject.quote(id) + ","
                        + JSONObject.quote(payload) + ")";
                webView.evaluateJavascript(script, null);
            }
        });
    }

    private void deliverAiResult(final String id, final String payload) {
        if (webView == null) return;
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (webView == null) return;
                String script = "window.__aiResult(" + JSONObject.quote(id) + ","
                        + JSONObject.quote(payload) + ")";
                webView.evaluateJavascript(script, null);
            }
        });
    }

    private void initTts() {
        initTtsWith(null, 0);
    }

    // Android 的 TextToSpeech 只有 SUCCESS / ERROR，没别的信息。
    // 默认引擎失败时换一个装上过的引擎再试一次，仍失败才认输。
    private void initTtsWith(final String enginePkg, final int attempt) {
        if (tts != null) {
            try { tts.shutdown(); } catch (Exception ignored) { }
            tts = null;
        }
        TextToSpeech.OnInitListener listener = new TextToSpeech.OnInitListener() {
            @Override public void onInit(int status) {
                if (status == TextToSpeech.SUCCESS && pickEnglishVoice()) {
                    attachTtsListener();
                    ttsReady = true;
                    ttsFail = "";
                    return;
                }
                if (attempt == 0) {
                    String next = nextEnginePackage(enginePkg);
                    if (next != null) { initTtsWith(next, 1); return; }
                }
                ttsReady = false;
                if (engineCount() == 0) {
                    ttsFail = "手机上没有安装任何语音引擎";
                } else if (status == TextToSpeech.SUCCESS) {
                    ttsFail = "语音引擎里没有英文语音包";
                } else {
                    ttsFail = "语音引擎初始化失败";
                }
                callJsTts("error", ttsFail);
            }
        };
        tts = (enginePkg == null) ? new TextToSpeech(this, listener)
                                  : new TextToSpeech(this, listener, enginePkg);
    }

    private boolean pickEnglishVoice() {
        if (tts == null) return false;
        // 系统设置里手动选的音色优先,别用打分把它改回美音。
        try {
            Voice cur = tts.getVoice();
            if (cur != null && cur.getLocale() != null
                    && "en".equals(cur.getLocale().getLanguage())) {
                java.util.Set<String> f = cur.getFeatures();
                if (f == null || !f.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) return true;
            }
        } catch (Exception ignored) { }
        try {
            Voice best = null;
            int bestScore = -1;
            for (Voice v : tts.getVoices()) {
                if (v == null) continue;
                Locale loc = v.getLocale();
                if (loc == null || !"en".equals(loc.getLanguage())) continue;
                java.util.Set<String> features = v.getFeatures();
                if (features != null
                        && features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) continue;
                int score = v.getQuality();
                if ("US".equals(loc.getCountry())) score += 60;
                else if ("GB".equals(loc.getCountry())) score += 40;
                if (!v.isNetworkConnectionRequired()) score += 25;
                if (score > bestScore) {
                    bestScore = score;
                    best = v;
                }
            }
            if (best != null && tts.setVoice(best) == TextToSpeech.SUCCESS) return true;
        } catch (Exception ignored) { }
        Locale[] order = { Locale.US, Locale.ENGLISH, Locale.UK };
        for (Locale l : order) {
            int r = tts.setLanguage(l);
            if (r == TextToSpeech.LANG_AVAILABLE
                    || r == TextToSpeech.LANG_COUNTRY_AVAILABLE
                    || r == TextToSpeech.LANG_COUNTRY_VAR_AVAILABLE) return true;
        }
        try {
            for (Locale l : tts.getAvailableLanguages()) {
                if (l != null && "en".equals(l.getLanguage())) {
                    tts.setLanguage(l);
                    return true;
                }
            }
        } catch (Exception ignored) { }
        return false;
    }

    private int engineCount() {
        try {
            TextToSpeech engine = tts;
            java.util.List<TextToSpeech.EngineInfo> list = engine == null ? null : engine.getEngines();
            return list == null ? 0 : list.size();
        } catch (Exception e) {
            return 0;
        }
    }

    private String nextEnginePackage(String tried) {
        try {
            TextToSpeech engine = tts;
            if (engine == null) return null;
            for (TextToSpeech.EngineInfo info : engine.getEngines()) {
                if (info != null && info.name != null && !info.name.equals(tried)) return info.name;
            }
        } catch (Exception ignored) { }
        return null;
    }

    private void attachTtsListener() {
        tts.setSpeechRate(0.9f);
        tts.setPitch(1.0f);
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String id) { callJsTts("start", id); }
            @Override public void onDone(String id) { callJsTts("done", id); }
            @Override public void onError(String id) { callJsTts("error", "朗读出错"); }
        });
    }

    private void callJsTts(final String state, final String payload) {
        if (webView == null) return;
        runOnUiThread(new Runnable() {
            @Override public void run() {
                if (webView == null) return;
                webView.evaluateJavascript("window.onTTS && window.onTTS(" + JSONObject.quote(state) + "," + JSONObject.quote(payload == null ? "" : payload) + ")", null);
            }
        });
    }

    private String readAll(InputStream input) throws Exception {
        if (input == null) return "";
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
        input.close();
        return new String(output.toByteArray(), "UTF-8");
    }

    private static String errorJson(String error) {
        try {
            JSONObject object = new JSONObject();
            object.put("ok", false);
            object.put("error", error == null || error.trim().isEmpty() ? "请求失败" : trim(error));
            return object.toString();
        } catch (Exception e) {
            return "{\"ok\":false,\"error\":\"请求失败\"}";
        }
    }

    private static String trim(String value) {
        if (value == null) return "";
        String clean = value.trim();
        return clean.length() <= 300 ? clean : clean.substring(0, 300) + "…";
    }

    private static String message(Exception e) {
        return e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
    }

    private void toast(final String text) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(MainActivity.this, text, Toast.LENGTH_SHORT).show();
            }
        });
    }

    private class Bridge {
        @JavascriptInterface
        public void onReady() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    pageReady = true;
                    takePendingImport();
                    deliverRoute();
                    // 上次下好、校验通过但还没装的包：让更新页直接显示「安装」按钮。
                    if (!apkPendingInstall.isEmpty()) notifyApk("ok", "安装包已就绪");
                }
            });
        }

        @JavascriptInterface
        public void setTheme(final boolean dark) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    applySystemBarTheme(dark);
                }
            });
        }

        @JavascriptInterface
        public void saveText(String name, String text) {
            saveToDownloads(name, text);
        }

        @JavascriptInterface
        public void copyText(final String text) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (text == null || text.trim().isEmpty()) return;
                    ClipboardManager cm = (ClipboardManager)
                            getSystemService(Context.CLIPBOARD_SERVICE);
                    if (cm == null) return;
                    cm.setPrimaryClip(ClipData.newPlainText("ldleRead", text));
                    toast("已复制");
                }
            });
        }

        @JavascriptInterface
        public void dictWord(final String id, final String word) {
            if (network == null || network.isShutdown()) {
                deliverDictResult(id, errorJson("应用已退出"));
                return;
            }
            network.execute(new Runnable() {
                @Override
                public void run() {
                    deliverDictResult(id, requestYoudao(word));
                }
            });
        }

        @JavascriptInterface
        public void aiChat(final String id, final String body, final String key) {
            if (network == null || network.isShutdown()) {
                deliverAiResult(id, errorJson("应用已退出"));
                return;
            }
            network.execute(new Runnable() {
                @Override
                public void run() {
                    deliverAiResult(id, requestDeepSeek(body, key));
                }
            });
        }

        @JavascriptInterface
        public void translate(final String id, final String body) {
            if (network == null || network.isShutdown()) {
                deliverTcResult(id, errorJson("应用已退出"));
                return;
            }
            network.execute(new Runnable() {
                @Override
                public void run() {
                    deliverTcResult(id, requestTencent(body));
                }
            });
        }

        @JavascriptInterface
        public void checkUpdate(final String id) {
            if (network == null || network.isShutdown()) {
                deliverUpdateResult(id, errorJson("应用已退出"));
                return;
            }
            network.execute(new Runnable() {
                @Override
                public void run() {
                    deliverUpdateResult(id, requestUpdate());
                }
            });
        }

        @JavascriptInterface
        public void downloadApk(final String url, final String fileName, final String sha,
                                final String mirrors) {
            String link = nz(url);
            String name = fileName == null || fileName.trim().isEmpty()
                    ? "IdleRead.apk" : new File(fileName.trim()).getName();
            if (!name.matches("[A-Za-z0-9._-]+")) name = "IdleRead.apk";
            if (!name.toLowerCase(Locale.US).endsWith(".apk")) name = name + ".apk";
            Uri uri = Uri.parse(link);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme();
            String host = uri.getHost() == null ? "" : uri.getHost();
            if (!"https".equals(scheme)) {
                toast("只能下载 https 链接");
                return;
            }
            if (!isApkHost(host)) {
                toast("这个地址不是官方发布链接");
                return;
            }
            // 落盘在应用自己的外部目录，任何系统版本都不需要存储权限。
            apkPermOpened = false;
            apkPendingInstall = "";
            apkInstallArmed = false;
            startApkDownload(link, name, sha, sanitizeMirrors(mirrors), false, false);
        }

        // 暂停 / 继续：下到一半想先干别的，或者信号变差了，都可以先停住。
        @JavascriptInterface
        public void pauseApkDownload() {
            if (RangeDownloader.busy()) RangeDownloader.pause();
        }

        @JavascriptInterface
        public void resumeApkDownload() {
            if (!apkPaused || apkRawUrl.isEmpty()) return;
            startApkDownload(apkRawUrl, apkFileName, apkExpectedSha, apkMirrors, true, false);
        }

        // 页面上的「安装」按钮：只有校验通过（apkPendingInstall 有值）才走得通。
        @JavascriptInterface
        public void installVerified() {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (apkPendingInstall.isEmpty()) {
                        notifyApk("fail", "安装包还没准备好，请重新下载");
                        return;
                    }
                    apkInstallArmed = true;
                    apkPermOpened = false;
                    retryPendingInstall();
                }
            });
        }

        // 页面刷新后问一句：有没有已经校验好、等着装的包。
        @JavascriptInterface
        public String apkReady() {
            return apkPendingInstall;
        }

        // 镜像下载 Google 语音引擎离线包（.apks），下完自动解包 + 分体安装。
        @JavascriptInterface
        public void downloadTtsPack(final String url, final String fileName, final String sha,
                                    final String mirrors) {
            String link = nz(url);
            String name = fileName == null || fileName.trim().isEmpty()
                    ? "GoogleTTS.apks" : new File(fileName.trim()).getName();
            if (!name.matches("[A-Za-z0-9._-]+")) name = "GoogleTTS.apks";
            Uri uri = Uri.parse(link);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme();
            String host = uri.getHost() == null ? "" : uri.getHost();
            if (!"https".equals(scheme)) {
                toast("只能下载 https 链接");
                return;
            }
            if (!isApkHost(host)) {
                toast("这个地址不是官方发布链接");
                return;
            }
            if (Build.VERSION.SDK_INT < 32) {
                notifyTts("unsupported", "这个引擎包要求 Android 12L 及以上，你的系统版本太低");
                return;
            }
            if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
                notifyTts("permission", "需要允许「安装未知应用」");
                toast("请允许「安装未知应用」，再点一次下载");
                openInstallSettings();
                return;
            }
            startTtsPackDownload(link, name, sha, sanitizeMirrors(mirrors), false, false);
        }

        @JavascriptInterface
        public void pauseTtsPackDownload() {
            if (RangeDownloader.busy()) RangeDownloader.pause();
        }

        @JavascriptInterface
        public void resumeTtsPackDownload() {
            if (!ttsPaused || ttsRawUrl.isEmpty()) return;
            startTtsPackDownload(ttsRawUrl, ttsPackName, ttsPackSha, ttsMirrors, true, false);
        }

        // 打开 Google Play 的引擎详情页。
        // 注意：不能用裸的 market://——小米等 ROM 会把它交给自家应用商店。
        // 必须 setPackage 指死 com.android.vending，才是真的 Play 商店。
        @JavascriptInterface
        public void openTtsStore() {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (!isPackageInstalled("com.android.vending")) {
                        notifyTts("fail", "这台手机没装 Google Play 商店，请用上面的镜像下载");
                        toast("没装 Google Play 商店，请用镜像下载");
                        return;
                    }
                    try {
                        Intent intent = new Intent(Intent.ACTION_VIEW,
                                Uri.parse("https://play.google.com/store/apps/details?id=" + TTS_PKG));
                        intent.setPackage("com.android.vending");
                        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(intent);
                    } catch (Exception e) {
                        toast("打不开 Google Play 商店，请用镜像下载");
                    }
                }
            });
        }

        @JavascriptInterface
        public String ttsPackInstalled() {
            return isPackageInstalled(TTS_PKG) ? "1" : "";
        }

        // 同步远端镜像清单：拿页面当前这份列表当「梯子」，任意一条能通就够。
        @JavascriptInterface
        public void syncMirrors(final String prefixesJson) {
            if (network == null || network.isShutdown()) return;
            final String[] prefixes = sanitizeMirrors(prefixesJson);
            network.execute(new Runnable() {
                @Override public void run() {
                    String body = fetchMirrorList(prefixes);
                    if (body == null) {
                        notifyMirrorSync("", "连不上任何一个源，换网络再试");
                        return;
                    }
                    notifyMirrorSync(body, "");
                }
            });
        }

        // 只查远端清单的日期，不替换：进更新页时用来提示「下载源已过时」。
        @JavascriptInterface
        public void checkMirrors(final String prefixesJson) {
            if (network == null || network.isShutdown()) return;
            final String[] prefixes = sanitizeMirrors(prefixesJson);
            network.execute(new Runnable() {
                @Override public void run() {
                    String body = fetchMirrorList(prefixes);
                    if (body == null) {
                        notifyMirrorCheck("", "连不上任何一个源");
                        return;
                    }
                    notifyMirrorCheck(body, "");
                }
            });
        }

        @JavascriptInterface
        public void openUrl(final String url) {
            final String link = nz(url);
            Uri uri = Uri.parse(link);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme();
            if (!"https".equals(scheme)) {
                toast("只能打开 https 链接");
                return;
            }
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(link)));
                    } catch (Exception e) {
                        toast("打不开链接");
                    }
                }
            });
        }

        @JavascriptInterface
        public void ttsSpeak(final String text) {
            if (tts == null || text == null || text.trim().isEmpty()) return;
            if (!ttsReady) {
                callJsTts("error", "语音引擎还没准备好，稍等一下再点");
                return;
            }
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "p" + (++ttsSeq));
                }
            });
        }

        @JavascriptInterface
        public void ttsSayWord(final String text) {
            if (!ttsReady || tts == null || text == null || text.trim().isEmpty()) return;
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "w" + (++ttsSeq));
                }
            });
        }

        @JavascriptInterface
        public void ttsStop() {
            if (tts == null) return;
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    tts.stop();
                    getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }

        @JavascriptInterface
        public void ttsSetRate(final float rate) {
            if (tts == null) return;
            runOnUiThread(new Runnable() {
                @Override public void run() { tts.setSpeechRate(Math.max(0.5f, Math.min(2.0f, rate))); }
            });
        }

        @JavascriptInterface
        public void ttsSetVoice(final float rate, final float pitch) {
            if (tts == null) return;
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    tts.setSpeechRate(Math.max(0.5f, Math.min(2.0f, rate)));
                    tts.setPitch(Math.max(0.5f, Math.min(2.0f, pitch)));
                }
            });
        }

        @JavascriptInterface
        public String ttsStatus() {
            if (ttsReady) return "ok";
            return ttsFail.isEmpty() ? "initializing" : ttsFail;
        }

        @JavascriptInterface
        public String ttsVoiceInfo() {
            JSONObject o = new JSONObject();
            try {
                o.put("engine", tts == null ? "" : String.valueOf(tts.getDefaultEngine()));
                Voice v = (tts == null) ? null : tts.getVoice();
                o.put("voice", v == null ? "" : String.valueOf(v.getName()));
                o.put("locale", v == null ? "" : String.valueOf(v.getLocale()));
                o.put("quality", v == null ? 0 : v.getQuality());
                o.put("network", v != null && v.isNetworkConnectionRequired());
                o.put("ready", ttsReady);
                // 页面靠这两项决定要不要推荐下载 Google 语音引擎
                o.put("google", isPackageInstalled(TTS_PKG));
                o.put("googleSelected",
                        tts != null && TTS_PKG.equals(String.valueOf(tts.getDefaultEngine())));
            } catch (Exception ignored) { }
            return o.toString();
        }

        @JavascriptInterface
        public void ttsOpenSettings() {
            ttsNeedsRefresh = true;
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    // SDK 里没有公开的 TTS 设置 action,只能先试 AOSP 的私有入口,
                    // 不行再退到系统的语音数据安装页。
                    try {
                        startActivity(new Intent("com.android.settings.TTS_SETTINGS"));
                    } catch (Exception e) {
                        try {
                            startActivity(new Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA));
                        } catch (Exception e2) {
                            toast("打不开语音设置，请到系统设置里搜索「语音」");
                        }
                    }
                }
            });
        }

        @JavascriptInterface
        public void openStore(final String pkg) {
            final String safe = (pkg == null) ? "" : pkg.trim();
            if (!safe.matches("[A-Za-z0-9._]+")) return;
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    Intent market = new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + safe));
                    market.setPackage("com.android.vending");
                    try { startActivity(market); return; } catch (Exception ignored) { }
                    // 没有 Play:应用内打开镜像站,不让系统弹浏览器选择框。
                    try {
                        Intent web = new Intent(MainActivity.this, WebPageActivity.class);
                        web.putExtra("url", "https://www.apkmirror.com/apk/google-inc/google-speech-services/");
                        startActivity(web);
                    } catch (Exception e) { toast("打不开下载页"); }
                }
            });
        }

        @JavascriptInterface
        public void restartApp(final String route) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    // 真重启:用新任务把 MainActivity 连同整个返回栈换掉,TTS 才会重新认引擎。
                    Intent i = new Intent(MainActivity.this, MainActivity.class);
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
                    if (route != null && route.length() <= 24) i.putExtra("open", route);
                    finish();
                    try {
                        startActivity(i);
                    } catch (Exception e) {
                        toast("重启失败");
                    }
                }
            });
        }
    }

    private class AppWebViewClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (uri == null || !APP_HOST.equals(uri.getHost())) return null;
            return loadAsset(uri.getPath());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return openExternal(url);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return openExternal(request.getUrl().toString());
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            super.onReceivedError(view, request, error);
        }

        private boolean openExternal(String url) {
            if (url == null) return true;
            if (url.startsWith("https://" + APP_HOST + "/") || url.startsWith("about:")) return false;
            if (url.startsWith("intent://") || url.startsWith("mailto:") || url.startsWith("tel:")) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Exception e) {
                    toast("手机里没有能打开这个链接的应用");
                }
            }
            return true;
        }
    }

    private class AppWebChromeClient extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;

            Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            // 不按 MIME 过滤:各家机型给 JSON 存档报的 MIME 五花八门,一过滤选择器就把它藏了。
            // 文件合不合法交给前端 importState 自己校验。
            intent.setType("*/*");
            try {
                startActivityForResult(Intent.createChooser(intent, "选择文件"), FILE_REQUEST);
            } catch (Exception e) {
                fileCallback = null;
                callback.onReceiveValue(null);
                toast("无法打开文件选择器");
            }
            return true;
        }
    }
}
