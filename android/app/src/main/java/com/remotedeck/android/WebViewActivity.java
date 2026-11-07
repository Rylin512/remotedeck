package com.remotedeck.android;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

import com.google.android.material.button.MaterialButton;

public class WebViewActivity extends AppCompatActivity {
    private WebView webView;
    private ProgressBar progress;
    private View errorView;
    private TextView errorText;
    private String url;
    private String profileId;
    private String profileName;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_web);

        url = getIntent().getStringExtra("url");
        profileId = getIntent().getStringExtra("profile_id");
        profileName = getIntent().getStringExtra("profile_name");
        if (url == null || url.isEmpty()) {
            finish();
            return;
        }
        if (profileName == null || profileName.isEmpty()) profileName = ProfileStore.hostName(url);
        if (profileId != null) ProfileStore.markLast(this, profileId);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        TextView title = findViewById(R.id.web_title);
        title.setText(profileName);
        progress = findViewById(R.id.web_progress);
        errorView = findViewById(R.id.error_view);
        errorText = findViewById(R.id.error_text);
        findViewById(R.id.open_tailscale_btn).setVisibility(View.GONE);

        findViewById(R.id.devices_btn).setOnClickListener(view -> openDeviceList());
        findViewById(R.id.reload_btn).setOnClickListener(view -> {
            errorView.setVisibility(View.GONE);
            webView.reload();
        });
        findViewById(R.id.new_window_btn).setOnClickListener(view -> openNewWindow());
        findViewById(R.id.retry_btn).setOnClickListener(view -> {
            errorView.setVisibility(View.GONE);
            webView.loadUrl(url);
        });
        findViewById(R.id.open_tailscale_btn).setOnClickListener(view -> TailscaleHelper.openOrConnect(this));

        webView = findViewById(R.id.webview);
        configureWebView(webView);

        TailscaleHelper.maybeConnect(this, url);
        if (TailscaleHelper.isTailscaleHost(url) && !TailscaleHelper.isVpnActive(this)) {
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(
                () -> webView.loadUrl(url), 1200
            );
        } else {
            webView.loadUrl(url);
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        String userAgent = settings.getUserAgentString();
        if (!userAgent.contains("RemoteDeckAndroid")) {
            settings.setUserAgentString(userAgent + " RemoteDeckAndroid/0.1.0");
        }

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(view, true);

        view.addJavascriptInterface(new NativeBridge(), "RemoteDeckNative");
        view.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView webView, String pageUrl, Bitmap favicon) {
                progress.setVisibility(View.VISIBLE);
                progress.setProgress(0);
                errorView.setVisibility(View.GONE);
                findViewById(R.id.open_tailscale_btn).setVisibility(View.GONE);
            }

            @Override
            public void onPageFinished(WebView webView, String pageUrl) {
                progress.setVisibility(View.GONE);
                CookieManager.getInstance().flush();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView webView, WebResourceRequest request) {
                return handleUrl(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView webView, String pageUrl) {
                return handleUrl(Uri.parse(pageUrl));
            }

            @Override
            public void onReceivedError(WebView webView, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showError(String.valueOf(error.getDescription()));
                }
            }
        });

        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView webView, int newProgress) {
                progress.setProgress(newProgress);
                progress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            }
        });

        view.setDownloadListener((downloadUrl, agent, contentDisposition, mimeType, contentLength) -> {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(downloadUrl)));
            } catch (Exception ignored) {}
        });
    }

    private boolean handleUrl(Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
        if ("http".equals(scheme) || "https".equals(scheme)) return false;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception ignored) {}
        return true;
    }

    private void showError(String detail) {
        progress.setVisibility(View.GONE);
        errorView.setVisibility(View.VISIBLE);
        errorText.setText(detail == null || detail.isEmpty() ? getString(R.string.error_loading) : detail);
        findViewById(R.id.open_tailscale_btn).setVisibility(
            TailscaleHelper.isTailscaleHost(url) ? View.VISIBLE : View.GONE
        );
    }

    private void openDeviceList() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.putExtra("show_list", true);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(intent);
        finish();
    }

    private void openNewWindow() {
        Intent intent = new Intent(this, WebViewActivity.class);
        intent.putExtra("url", url);
        intent.putExtra("profile_id", profileId);
        intent.putExtra("profile_name", profileName);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_DOCUMENT
            | Intent.FLAG_ACTIVITY_MULTIPLE_TASK
            | Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(intent);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        openDeviceList();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        if (webView != null && errorView != null && errorView.getVisibility() == View.VISIBLE
            && TailscaleHelper.isTailscaleHost(url) && TailscaleHelper.isVpnActive(this)) {
            errorView.setVisibility(View.GONE);
            webView.loadUrl(url);
        }
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.removeJavascriptInterface("RemoteDeckNative");
            webView.destroy();
        }
        super.onDestroy();
    }

    private class NativeBridge {
        @JavascriptInterface
        public void setKeepScreenOn(boolean enabled) {
            runOnUiThread(() -> {
                if (enabled) {
                    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }

        @JavascriptInterface
        public void toast(String message) {
            runOnUiThread(() -> Toast.makeText(WebViewActivity.this, message, Toast.LENGTH_SHORT).show());
        }
    }
}
