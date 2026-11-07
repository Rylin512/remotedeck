package com.remotedeck.android;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.widget.Toast;

import java.net.URI;

final class TailscaleHelper {
    private static final String[] PACKAGES = { "com.tailscale.ipn", "com.tailscale.ipn.mdm" };
    private static final String[] CONNECT_ACTIONS = {
        "com.tailscale.ipn.CONNECT_VPN",
    };

    private TailscaleHelper() {}

    static boolean isTailscaleHost(String url) {
        try {
            URI uri = URI.create(ProfileStore.normalizeUrl(url));
            String host = uri.getHost();
            if (host == null) return false;
            if (host.endsWith(".ts.net")) return true;
            String[] parts = host.split("\\.");
            if (parts.length != 4) return false;
            int first = Integer.parseInt(parts[0]);
            int second = Integer.parseInt(parts[1]);
            return first == 100 && second >= 64 && second <= 127;
        } catch (Exception ignored) {
            return false;
        }
    }

    static boolean isInstalled(Context context) {
        for (String pkg : PACKAGES) {
            try {
                context.getPackageManager().getPackageInfo(pkg, 0);
                return true;
            } catch (PackageManager.NameNotFoundException ignored) {}
        }
        return false;
    }

    static boolean isVpnActive(Context context) {
        try {
            ConnectivityManager manager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (manager == null) return false;
            for (Network network : manager.getAllNetworks()) {
                NetworkCapabilities caps = manager.getNetworkCapabilities(network);
                if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return true;
            }
        } catch (Exception ignored) {}
        return false;
    }

    static void maybeConnect(Activity activity, String url) {
        if (!isTailscaleHost(url) || isVpnActive(activity) || !isInstalled(activity)) return;
        sendConnectBroadcast(activity);
    }

    static void openOrConnect(Activity activity) {
        if (!isInstalled(activity)) {
            Toast.makeText(activity, R.string.tailscale_missing, Toast.LENGTH_LONG).show();
            try {
                activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=com.tailscale.ipn")));
            } catch (ActivityNotFoundException ignored) {}
            return;
        }
        sendConnectBroadcast(activity);
        Toast.makeText(activity, R.string.tailscale_opening, Toast.LENGTH_SHORT).show();
        for (String pkg : PACKAGES) {
            Intent launch = activity.getPackageManager().getLaunchIntentForPackage(pkg);
            if (launch == null) continue;
            try {
                activity.startActivity(launch);
                return;
            } catch (Exception ignored) {}
        }
    }

    private static void sendConnectBroadcast(Context context) {
        for (String pkg : PACKAGES) {
            for (String action : CONNECT_ACTIONS) {
                try {
                    Intent intent = new Intent(action);
                    intent.setPackage(pkg);
                    context.sendBroadcast(intent);
                } catch (Exception ignored) {}
            }
        }
    }
}
