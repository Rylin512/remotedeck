package com.remotedeck.android;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

final class ProfileStore {
    static final String PREFS = "remotedeck_android";
    private static final String KEY_PROFILES = "profiles";
    private static final String KEY_LAST = "last_profile";

    static final class Profile {
        final String id;
        final String name;
        final String url;

        Profile(String id, String name, String url) {
            this.id = id;
            this.name = name;
            this.url = url;
        }
    }

    private ProfileStore() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static List<Profile> load(Context context) {
        List<Profile> out = new ArrayList<>();
        try {
            String raw = prefs(context).getString(KEY_PROFILES, "[]");
            JSONArray array = new JSONArray(raw);
            for (int i = 0; i < array.length(); i++) {
                JSONObject row = array.getJSONObject(i);
                String url = row.optString("url", "");
                if (url.isEmpty()) continue;
                out.add(new Profile(
                    row.optString("id", UUID.randomUUID().toString()),
                    row.optString("name", hostName(url)),
                    url
                ));
            }
        } catch (Exception ignored) {}
        return out;
    }

    static Profile find(Context context, String id) {
        for (Profile profile : load(context)) {
            if (profile.id.equals(id)) return profile;
        }
        return null;
    }

    static Profile add(Context context, String url) {
        String normalized = normalizeUrl(url);
        List<Profile> profiles = load(context);
        for (Profile profile : profiles) {
            if (profile.url.equals(normalized)) {
                prefs(context).edit().putString(KEY_LAST, profile.id).apply();
                return profile;
            }
        }
        Profile profile = new Profile(UUID.randomUUID().toString(), hostName(normalized), normalized);
        profiles.add(profile);
        save(context, profiles);
        prefs(context).edit().putString(KEY_LAST, profile.id).apply();
        return profile;
    }

    static void remove(Context context, String id) {
        List<Profile> profiles = load(context);
        profiles.removeIf(profile -> profile.id.equals(id));
        save(context, profiles);
        if (id.equals(prefs(context).getString(KEY_LAST, ""))) {
            prefs(context).edit().remove(KEY_LAST).apply();
        }
    }

    static void markLast(Context context, String id) {
        prefs(context).edit().putString(KEY_LAST, id).apply();
    }

    static String lastId(Context context) {
        return prefs(context).getString(KEY_LAST, "");
    }

    private static void save(Context context, List<Profile> profiles) {
        JSONArray array = new JSONArray();
        for (Profile profile : profiles) {
            try {
                JSONObject row = new JSONObject();
                row.put("id", profile.id);
                row.put("name", profile.name);
                row.put("url", profile.url);
                array.put(row);
            } catch (Exception ignored) {}
        }
        prefs(context).edit().putString(KEY_PROFILES, array.toString()).apply();
    }

    static String normalizeUrl(String input) {
        String url = input == null ? "" : input.trim();
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "http://" + url;
        }
        if (!url.endsWith("/")) url += "/";
        return url;
    }

    static boolean isValidUrl(String input) {
        try {
            String url = normalizeUrl(input);
            URI uri = URI.create(url);
            String scheme = uri.getScheme();
            return ("http".equals(scheme) || "https".equals(scheme))
                && uri.getHost() != null
                && !uri.getHost().isEmpty();
        } catch (Exception ignored) {
            return false;
        }
    }

    static String hostName(String url) {
        try {
            URI uri = URI.create(normalizeUrl(url));
            String host = uri.getHost();
            if (host == null || host.isEmpty()) return "RemoteDeck";
            int port = uri.getPort();
            return port > 0 ? host + ":" + port : host;
        } catch (Exception ignored) {
            return "RemoteDeck";
        }
    }
}
