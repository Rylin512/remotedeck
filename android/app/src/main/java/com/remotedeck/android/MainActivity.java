package com.remotedeck.android;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.text.InputType;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.google.android.material.button.MaterialButton;
import com.google.android.material.textfield.TextInputEditText;
import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanOptions;

import java.util.List;

public class MainActivity extends AppCompatActivity {
    private static final int CAMERA_REQUEST = 41;

    private LinearLayout profileList;
    private TextView emptyHint;
    private ActivityResultLauncher<ScanOptions> scanLauncher;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        profileList = findViewById(R.id.profile_list);
        emptyHint = findViewById(R.id.empty_hint);

        scanLauncher = registerForActivityResult(new ScanContract(), result -> {
            if (result.getContents() == null) return;
            addAndOpen(result.getContents());
        });

        findViewById(R.id.scan_btn).setOnClickListener(view -> startScan());
        findViewById(R.id.manual_btn).setOnClickListener(view -> showManualDialog());
        findViewById(R.id.tailscale_btn).setOnClickListener(view -> TailscaleHelper.openOrConnect(this));

        List<ProfileStore.Profile> profiles = ProfileStore.load(this);
        boolean showList = getIntent().getBooleanExtra("show_list", false);
        if (profiles.isEmpty()) {
            renderProfiles();
        } else if (!showList) {
            ProfileStore.Profile last = ProfileStore.find(this, ProfileStore.lastId(this));
            if (last == null) last = profiles.get(0);
            openProfile(last, false);
        } else {
            renderProfiles();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (profileList != null) renderProfiles();
    }

    private void startScan() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.CAMERA}, CAMERA_REQUEST);
            return;
        }
        ScanOptions options = new ScanOptions();
        options.setDesiredBarcodeFormats(ScanOptions.QR_CODE);
        options.setPrompt(getString(R.string.scan_prompt));
        options.setBeepEnabled(false);
        options.setOrientationLocked(false);
        scanLauncher.launch(options);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == CAMERA_REQUEST && grantResults.length > 0
            && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            startScan();
        } else if (requestCode == CAMERA_REQUEST) {
            Toast.makeText(this, "需要相机权限才能扫描二维码", Toast.LENGTH_LONG).show();
        }
    }

    private void addAndOpen(String raw) {
        String url = extractUrl(raw);
        if (!ProfileStore.isValidUrl(url)) {
            Toast.makeText(this, R.string.invalid_url, Toast.LENGTH_LONG).show();
            return;
        }
        ProfileStore.Profile profile = ProfileStore.add(this, url);
        TailscaleHelper.maybeConnect(this, profile.url);
        openProfile(profile, false);
    }

    private String extractUrl(String raw) {
        if (raw == null) return "";
        String text = raw.trim();
        if (text.startsWith("http://") || text.startsWith("https://")) return text;
        java.util.regex.Matcher matcher = java.util.regex.Pattern
            .compile("https?://[^\\s]+")
            .matcher(text);
        return matcher.find() ? matcher.group() : text;
    }

    private void showManualDialog() {
        View view = LayoutInflater.from(this).inflate(R.layout.dialog_url, null);
        TextInputEditText input = view.findViewById(R.id.url_input);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint(R.string.url_hint);
        AlertDialog dialog = new AlertDialog.Builder(this)
            .setTitle(R.string.manual_title)
            .setView(view)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.save, null)
            .create();
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            String url = String.valueOf(input.getText()).trim();
            if (url.isEmpty() || !ProfileStore.isValidUrl(url)) {
                input.setError(getString(R.string.invalid_url));
                return;
            }
            dialog.dismiss();
            addAndOpen(url);
        }));
        dialog.show();
    }

    private void renderProfiles() {
        if (profileList == null) return;
        List<ProfileStore.Profile> profiles = ProfileStore.load(this);
        profileList.removeAllViews();
        emptyHint.setVisibility(profiles.isEmpty() ? View.VISIBLE : View.GONE);
        LayoutInflater inflater = LayoutInflater.from(this);
        for (ProfileStore.Profile profile : profiles) {
            View row = inflater.inflate(R.layout.item_profile, profileList, false);
            TextView name = row.findViewById(R.id.profile_name);
            TextView url = row.findViewById(R.id.profile_url);
            name.setText(profile.name);
            url.setText(profile.url);
            row.findViewById(R.id.profile_open).setOnClickListener(v -> openProfile(profile, false));
            row.findViewById(R.id.profile_new_window).setOnClickListener(v -> openProfile(profile, true));
            row.findViewById(R.id.profile_delete).setOnClickListener(v -> confirmDelete(profile));
            profileList.addView(row);
        }
    }

    private void confirmDelete(ProfileStore.Profile profile) {
        new AlertDialog.Builder(this)
            .setTitle(R.string.delete_title)
            .setMessage(R.string.delete_message)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.delete, (dialog, which) -> {
                ProfileStore.remove(this, profile.id);
                renderProfiles();
            })
            .show();
    }

    private void openProfile(ProfileStore.Profile profile, boolean newTask) {
        ProfileStore.markLast(this, profile.id);
        TailscaleHelper.maybeConnect(this, profile.url);
        Intent intent = new Intent(this, WebViewActivity.class);
        intent.putExtra("url", profile.url);
        intent.putExtra("profile_id", profile.id);
        intent.putExtra("profile_name", profile.name);
        if (newTask) {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_DOCUMENT
                | Intent.FLAG_ACTIVITY_MULTIPLE_TASK
                | Intent.FLAG_ACTIVITY_NEW_TASK);
        }
        startActivity(intent);
    }
}
