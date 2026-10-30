package com.ldleread.app;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebView;
import android.webkit.WebViewClient;

// 内置浏览器:只给下载引擎这类页面用,避免系统弹「选择浏览器」。
public class WebPageActivity extends Activity {
    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        String url = getIntent() == null ? null : getIntent().getStringExtra("url");
        if (url == null || !url.startsWith("https://")) { finish(); return; }
        WebView w = new WebView(this);
        w.getSettings().setJavaScriptEnabled(true);
        w.getSettings().setDomStorageEnabled(true);
        w.getSettings().setAllowFileAccess(false);
        w.setWebViewClient(new WebViewClient());
        setContentView(w);
        w.loadUrl(url);
    }
}
