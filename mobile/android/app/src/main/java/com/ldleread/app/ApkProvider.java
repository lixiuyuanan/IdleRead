package com.ldleread.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * 给系统安装器喂 APK 用的最小 ContentProvider。
 *
 * 工程不走 Gradle、没有 androidx，用不了 FileProvider，所以自己写一个：
 * 只暴露 getExternalFilesDir("apk") 这一个目录，只读，路径里出现分隔符或 .. 一律拒绝。
 * 用法和 FileProvider 一样：Intent 带 FLAG_GRANT_READ_URI_PERMISSION，
 * 清单里 exported=false + grantUriPermissions=true。
 */
public class ApkProvider extends ContentProvider {
    public static final String AUTHORITY = "com.ldleread.app.apk";
    public static final String DIR = "apk";

    public static File dir(Context context) {
        File base = context.getExternalFilesDir(DIR);
        if (base == null) base = new File(context.getFilesDir(), DIR);
        if (!base.exists()) base.mkdirs();
        return base;
    }

    public static Uri uriFor(Context context, File file) {
        return new Uri.Builder()
                .scheme("content")
                .authority(AUTHORITY)
                .appendPath(file.getName())
                .build();
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    // 只认目录内的单层文件名，挡住 ../ 和子目录。
    private File resolve(Uri uri) {
        if (uri == null) return null;
        String name = uri.getLastPathSegment();
        if (name == null || name.isEmpty()) return null;
        if (name.indexOf('/') >= 0 || name.indexOf('\\') >= 0 || name.contains("..")) return null;
        File base = dir(getContext());
        File target = new File(base, name);
        try {
            String basePath = base.getCanonicalPath();
            if (!target.getCanonicalPath().equals(basePath + File.separator + name)) return null;
        } catch (Exception e) {
            return null;
        }
        return target.exists() ? target : null;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File file = resolve(uri);
        if (file == null) throw new FileNotFoundException("找不到安装包");
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
                        String[] selectionArgs, String sortOrder) {
        File file = resolve(uri);
        if (file == null) return null;
        String[] columns = projection != null ? projection
                : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor cursor = new MatrixCursor(columns, 1);
        Object[] row = new Object[columns.length];
        for (int i = 0; i < columns.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(columns[i])) row[i] = file.getName();
            else if (OpenableColumns.SIZE.equals(columns[i])) row[i] = file.length();
            else row[i] = null;
        }
        cursor.addRow(row);
        return cursor;
    }

    @Override
    public String getType(Uri uri) {
        return "application/vnd.android.package-archive";
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
