package com.android.thememanager.activity;

import android.accounts.Account;
import android.accounts.AccountManager;
import android.app.Activity;
import android.app.ProgressDialog;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.AsyncTask;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.text.TextUtils;
import android.util.Log;
import android.widget.TextView;
import android.widget.Toast;
import androidx.lifecycle.k0;
import com.android.thememanager.R;
import com.android.thememanager.basemodule.model.ResourceContext;
import com.android.thememanager.basemodule.resource.ResourceHelper;
import com.android.thememanager.basemodule.resource.constants.ThemeResourceConstants;
import com.android.thememanager.basemodule.resource.model.ApplyThemeInfo;
import com.android.thememanager.basemodule.resource.model.RelatedResource;
import com.android.thememanager.basemodule.resource.model.Resource;
import com.android.thememanager.basemodule.utils.h2;
import com.android.thememanager.basemodule.utils.i0;
import com.android.thememanager.basemodule.utils.j0;
import com.android.thememanager.basemodule.utils.y0;
import com.android.thememanager.basemodule.utils.y1;
import com.google.firebase.analytics.FirebaseAnalytics;
import com.google.firebase.sessions.settings.RemoteSettings;
import com.miui.miapm.block.core.LifeCycleRecorder;
import com.miui.miapm.block.core.MethodRecorder;
import com.miui.miapm.record.EventRecorder;
import com.theme.pet.webview.AdoptJsFeature;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.lang.ref.SoftReference;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import miui.util.DeviceUtils;

/* JADX INFO: compiled from: r8-map-id-15233a4145dd155ba1d32e96c0900a002f8f4134c220df1ca698b809ba9c00e4 */
/* JADX INFO: loaded from: classes4.dex */
public class ApplyThemeForScreenshot extends Activity implements ThemeResourceConstants {

    /* JADX INFO: renamed from: g, reason: collision with root package name */
    private static final String f54815g = "snapshot";

    /* JADX INFO: renamed from: h, reason: collision with root package name */
    private static final String f54816h = "RestoreFromConfigurationChange";

    /* JADX INFO: renamed from: i, reason: collision with root package name */
    private static final boolean f54817i = false;

    /* JADX INFO: renamed from: j, reason: collision with root package name */
    private static final String f54818j = "default";

    /* JADX INFO: renamed from: k, reason: collision with root package name */
    private static final String f54819k = "theme_file_path";

    /* JADX INFO: renamed from: l, reason: collision with root package name */
    private static final String f54820l = "theme_apply_flags";

    /* JADX INFO: renamed from: m, reason: collision with root package name */
    private static final String f54821m = "theme_remove_flags";

    /* JADX INFO: renamed from: n, reason: collision with root package name */
    private static final String f54822n = "api_called_from";

    /* JADX INFO: renamed from: o, reason: collision with root package name */
    private static final String f54823o = "ver2_step";

    /* JADX INFO: renamed from: p, reason: collision with root package name */
    private static final String f54824p = "ver2_step_init";

    /* JADX INFO: renamed from: q, reason: collision with root package name */
    private static final String f54825q = "ver2_step_apply";

    /* JADX INFO: renamed from: r, reason: collision with root package name */
    private static String f54826r;

    /* JADX INFO: renamed from: a, reason: collision with root package name */
    private String f54827a;

    /* JADX INFO: renamed from: b, reason: collision with root package name */
    private TextView f54828b;

    /* JADX INFO: renamed from: c, reason: collision with root package name */
    public String f54829c;

    /* JADX INFO: renamed from: d, reason: collision with root package name */
    private String f54830d;

    /* JADX INFO: renamed from: e, reason: collision with root package name */
    private Set<String> f54831e = new HashSet();

    /* JADX INFO: renamed from: f, reason: collision with root package name */
    private String f54832f;

    /* JADX INFO: compiled from: r8-map-id-15233a4145dd155ba1d32e96c0900a002f8f4134c220df1ca698b809ba9c00e4 */
    class a extends d {
        a() {
            super();
        }

        /* JADX INFO: Access modifiers changed from: protected */
        @Override // com.android.thememanager.activity.ApplyThemeForScreenshot.d, android.os.AsyncTask
        /* JADX INFO: renamed from: e, reason: merged with bridge method [inline-methods] */
        public void onPostExecute(Integer num) {
            MethodRecorder.i(17484);
            super.onPostExecute(num);
            Intent intent = new Intent();
            intent.putExtra("init_result", num.intValue());
            ApplyThemeForScreenshot.this.setResult(-1, intent);
            ApplyThemeForScreenshot.this.finish();
            MethodRecorder.o(17484);
        }
    }

    /* JADX INFO: compiled from: r8-map-id-15233a4145dd155ba1d32e96c0900a002f8f4134c220df1ca698b809ba9c00e4 */
    class b extends com.android.thememanager.util.f {

        /* JADX INFO: renamed from: u, reason: collision with root package name */
        final /* synthetic */ Resource f54834u;

        /* JADX WARN: 'super' call moved to the top of the method (can break code semantics) */
        b(Context context, ResourceContext resourceContext, Resource resource, ApplyThemeInfo applyThemeInfo, k0 k0Var, Resource resource2) {
            super(context, resourceContext, resource, applyThemeInfo, k0Var);
            this.f54834u = resource2;
        }

        /* JADX INFO: Access modifiers changed from: protected */
        @Override // com.android.thememanager.util.f, android.os.AsyncTask
        /* JADX INFO: renamed from: C */
        public void onPostExecute(String str) {
            long jO;
            MethodRecorder.i(17406);
            super.onPostExecute(str);
            Intent intent = new Intent();
            Bundle bundle = new Bundle();
            int localPlatform = this.f54834u.getLocalPlatform();
            if ("theme".equals(ApplyThemeForScreenshot.this.f54830d)) {
                Iterator<RelatedResource> it = this.f54834u.getSubResources().iterator();
                jO = 0;
                while (it.hasNext()) {
                    String resourceCode = it.next().getResourceCode();
                    if (!ApplyThemeForScreenshot.this.f54831e.contains(resourceCode) && y1.z(localPlatform, resourceCode)) {
                        jO |= com.android.thememanager.basemodule.utils.e.o(com.android.thememanager.basemodule.utils.e.s(resourceCode));
                    }
                }
            } else {
                jO = "lockstyle".equals(ApplyThemeForScreenshot.this.f54830d) ? 4100L : com.android.thememanager.basemodule.utils.e.o(ApplyThemeForScreenshot.this.f54830d);
            }
            bundle.putLong(e3.e.AN, jO);
            bundle.putString("path", ApplyThemeForScreenshot.this.f54829c);
            bundle.putString("title", this.f54834u.getLocalInfo().getTitle());
            bundle.putString("author", this.f54834u.getLocalInfo().getAuthor());
            bundle.putString("version", this.f54834u.getLocalInfo().getVersion());
            bundle.putString(e3.e.VI, String.valueOf(localPlatform));
            intent.putExtras(bundle);
            ApplyThemeForScreenshot.this.setResult(-1, intent);
            ApplyThemeForScreenshot.this.finish();
            MethodRecorder.o(17406);
        }
    }

    /* JADX INFO: compiled from: r8-map-id-15233a4145dd155ba1d32e96c0900a002f8f4134c220df1ca698b809ba9c00e4 */
    private static class c {

        /* JADX INFO: renamed from: a, reason: collision with root package name */
        private String f54836a;

        /* JADX INFO: renamed from: b, reason: collision with root package name */
        private String f54837b;

        /* JADX INFO: renamed from: c, reason: collision with root package name */
        private String f54838c;

        /* JADX INFO: renamed from: d, reason: collision with root package name */
        private String f54839d;

        /* JADX INFO: renamed from: e, reason: collision with root package name */
        private String f54840e;

        /* JADX INFO: renamed from: f, reason: collision with root package name */
        private String f54841f;

        /* JADX INFO: renamed from: g, reason: collision with root package name */
        private boolean f54842g;

        public c(String str) {
            if (TextUtils.isEmpty(str) || !str.startsWith("/sdcard") || !str.endsWith(".mtz")) {
                Log.d(ApplyThemeForScreenshot.f54815g, "chownMtz2Theme mtzPath error. path=" + str);
                return;
            }
            String strSubstring = str.substring(str.lastIndexOf(RemoteSettings.f109300i) + 1);
            this.f54836a = strSubstring;
            this.f54837b = strSubstring.substring(0, strSubstring.lastIndexOf(".mtz"));
            this.f54838c = str.substring(8, str.lastIndexOf(this.f54836a) - 1);
            this.f54839d = str.substring(7);
            this.f54840e = Environment.getExternalStorageDirectory() + this.f54839d;
            this.f54841f = Environment.getExternalStorageDirectory() + RemoteSettings.f109300i + this.f54838c;
            this.f54842g = true;
        }

        public String c() {
            MethodRecorder.i(17400);
            String str = this.f54836a;
            MethodRecorder.o(17400);
            return str;
        }

        public String d() {
            MethodRecorder.i(17403);
            String str = this.f54839d;
            MethodRecorder.o(17403);
            return str;
        }

        public String e() {
            MethodRecorder.i(17404);
            String str = this.f54840e;
            MethodRecorder.o(17404);
            return str;
        }

        public String f() {
            MethodRecorder.i(17402);
            String str = this.f54838c;
            MethodRecorder.o(17402);
            return str;
        }

        public String g() {
            MethodRecorder.i(17405);
            String str = this.f54841f;
            MethodRecorder.o(17405);
            return str;
        }

        public String h() {
            MethodRecorder.i(17401);
            String str = this.f54837b;
            MethodRecorder.o(17401);
            return str;
        }

        public boolean i() {
            MethodRecorder.i(17399);
            boolean z10 = this.f54842g;
            MethodRecorder.o(17399);
            return z10;
        }
    }

    /* JADX INFO: compiled from: r8-map-id-15233a4145dd155ba1d32e96c0900a002f8f4134c220df1ca698b809ba9c00e4 */
    private class d extends AsyncTask<String, Void, Integer> {

        /* JADX INFO: renamed from: b, reason: collision with root package name */
        private static final int f54843b = 0;

        /* JADX INFO: renamed from: c, reason: collision with root package name */
        private static final int f54844c = -1;

        /* JADX INFO: renamed from: d, reason: collision with root package name */
        private static final int f54845d = -2;

        private String a(String str) {
            MethodRecorder.i(17749);
            if (TextUtils.isEmpty(str) || !str.startsWith("/sdcard") || !str.endsWith(".mtz")) {
                Log.d(ApplyThemeForScreenshot.f54815g, "chownMtz2Theme mtzPath error. path=" + str);
                MethodRecorder.o(17749);
                return null;
            }
            try {
                String strSubstring = str.substring(str.lastIndexOf(RemoteSettings.f109300i) + 1);
                String strSubstring2 = strSubstring.substring(0, strSubstring.lastIndexOf(".mtz"));
                String strSubstring3 = str.substring(8, str.lastIndexOf(strSubstring) - 1);
                String str2 = Environment.getExternalStorageDirectory() + str.substring(7);
                Uri contentUri = MediaStore.Files.getContentUri("external");
                ContentValues contentValues = new ContentValues();
                contentValues.put("title", strSubstring2);
                contentValues.put("_display_name", strSubstring);
                contentValues.put("relative_path", strSubstring3);
                contentValues.put("_data", str2);
                contentValues.put(AdoptJsFeature.f140297j, (Integer) 1);
                contentValues.put(com.android.thememanager.basemodule.utils.wallpaper.c0.J, "application/octet-stream");
                contentValues.put("owner_package_name", "com.android.thememanager");
                String string = f3.a.b().getContentResolver().insert(contentUri, contentValues).toString();
                MethodRecorder.o(17749);
                return string;
            } catch (Exception e10) {
                Log.d(ApplyThemeForScreenshot.f54815g, "chownMtz2Theme filed.", e10);
                MethodRecorder.o(17749);
                return null;
            }
        }

        private void b() {
            MethodRecorder.i(17748);
            Log.d(ApplyThemeForScreenshot.f54815g, "clearThemeDataFromFile count=" + f3.a.b().getContentResolver().delete(MediaStore.Files.getContentUri("external"), "(owner_package_name LIKE 'com.android.thememanager' )", null));
            MethodRecorder.o(17748);
        }

        private boolean d(String str) {
            MethodRecorder.i(17750);
            try {
                Cursor cursorQuery = f3.a.b().getContentResolver().query(MediaStore.Files.getContentUri("external"), null, "(owner_package_name LIKE '%com.android.themamanager%' OR _display_name LIKE '" + str + "%.mtz' )", null, null);
                int count = cursorQuery.getCount();
                Log.d(ApplyThemeForScreenshot.f54815g, "mtzNameChangedAfterInsertDB. count=" + count);
                cursorQuery.close();
                boolean z10 = count > 1;
                MethodRecorder.o(17750);
                return z10;
            } catch (Exception e10) {
                Log.e(ApplyThemeForScreenshot.f54815g, "query count=" + e10);
                MethodRecorder.o(17750);
                return false;
            }
        }

        /* JADX INFO: Access modifiers changed from: protected */
        @Override // android.os.AsyncTask
        /* JADX INFO: renamed from: c, reason: merged with bridge method [inline-methods] */
        public Integer doInBackground(String... strArr) {
            MethodRecorder.i(17747);
            if (!TextUtils.equals(ApplyThemeForScreenshot.f54824p, strArr[1])) {
                MethodRecorder.o(17747);
                return -1;
            }
            c cVar = new c(strArr[0]);
            if (!cVar.i()) {
                MethodRecorder.o(17747);
                return -1;
            }
            MediaScannerConnection.scanFile(f3.a.b(), new String[]{cVar.f54840e}, null, null);
            s3.i.C(cVar.g());
            b();
            String strA = a(strArr[0]);
            if (d(cVar.f54837b)) {
                MethodRecorder.o(17747);
                return -2;
            }
            Log.e(ApplyThemeForScreenshot.f54815g, "chownMtz2Theme success. uriString=" + strA);
            MethodRecorder.o(17747);
            return 0;
        }

        /* JADX INFO: Access modifiers changed from: protected */
        @Override // android.os.AsyncTask
        /* JADX INFO: renamed from: e */
        public void onPostExecute(Integer num) {
            MethodRecorder.i(17751);
            if (num.intValue() == -2) {
                Toast.makeText(ApplyThemeForScreenshot.this, "应用错误，请更换文件名", 0).show();
            } else if (num.intValue() == -1) {
                Toast.makeText(ApplyThemeForScreenshot.this, "应用失败，路径错误", 0).show();
            } else {
                Toast.makeText(ApplyThemeForScreenshot.this, "可以按当前路径push文件了", 0).show();
            }
            MethodRecorder.o(17751);
        }

        private d() {
        }
    }

    /* JADX INFO: compiled from: r8-map-id-15233a4145dd155ba1d32e96c0900a002f8f4134c220df1ca698b809ba9c00e4 */
    private static final class e extends g {

        /* JADX INFO: renamed from: c, reason: collision with root package name */
        private final Uri f54847c;

        public e(ApplyThemeForScreenshot applyThemeForScreenshot, Uri uri) {
            super(applyThemeForScreenshot);
            this.f54847c = uri;
        }

        /* JADX WARN: Code restructure failed: missing block: B:35:0x00d7, code lost:
        
            r0 = move-exception;
         */
        /* JADX WARN: Code restructure failed: missing block: B:36:0x00d8, code lost:
        
            r14 = r0;
         */
        /* JADX WARN: Code restructure failed: missing block: B:37:0x00da, code lost:
        
            r13 = null;
         */
        /* JADX WARN: Code restructure failed: missing block: B:38:0x00dc, code lost:
        
            r0 = move-exception;
         */
        /* JADX WARN: Code restructure failed: missing block: B:39:0x00dd, code lost:
        
            r14 = r0;
            r13 = null;
         */
        /* JADX WARN: Code restructure failed: missing block: B:47:0x010f, code lost:
        
            s3.a.a(r2);
            com.miui.miapm.block.core.MethodRecorder.o(17556);
         */
        /* JADX WARN: Code restructure failed: missing block: B:48:0x0115, code lost:
        
            throw r14;
         */
        /* JADX WARN: Multi-variable type inference failed */
        /* JADX WARN: Type inference failed for: r2v1 */
        /* JADX WARN: Type inference failed for: r2v2 */
        /* JADX WARN: Type inference failed for: r2v3, types: [java.lang.AutoCloseable] */
        /*
            Code decompiled incorrectly, please refer to instructions dump.
            To view partially-correct add '--show-bad-code' argument
        */
        private java.lang.String c(android.net.Uri r13, java.lang.String r14) throws java.lang.Throwable {
            /*
                Method dump skipped, instruction units count: 278
                To view this dump add '--comments-level debug' option
            */
            throw new UnsupportedOperationException("Method not decompiled: com.android.thememanager.activity.ApplyThemeForScreenshot.e.c(android.net.Uri, java.lang.String):java.lang.String");
        }

        /* JADX INFO: Access modifiers changed from: protected */
        @Override // com.android.thememanager.activity.ApplyThemeForScreenshot.g, android.os.AsyncTask
        /* JADX INFO: renamed from: a, reason: merged with bridge method [inline-methods] */
        public Resource doInBackground(String... strArr) throws Throwable {
            MethodRecorder.i(17557);
            Resource resourceDoInBackground = super.doInBackground(c(this.f54847c, strArr[0]), strArr[1]);
            MethodRecorder.o(17557);
            return resourceDoInBackground;
        }

        /* JADX INFO: Access modifiers changed from: protected */
        @Override // com.android.thememanager.activity.ApplyThemeForScreenshot.g, android.os.AsyncTask
        /* JADX INFO: renamed from: b, reason: merged with bridge method [inline-methods] */
        public void onPostExecute(Resource resource) {
            MethodRecorder.i(17558);
            super.onPostExecute(resource);
            MethodRecorder.o(17558);
        }
    }

    /* JADX INFO: compiled from: r8-map-id-15233a4145dd155ba1d32e96c0900a002f8f4134c220df1ca698b809ba9c00e4 */
    private static final class f extends g {

        /* JADX INFO: renamed from: c, reason: collision with root package name */
        private static final String f54848c = "/sdcard/Android/data/com.android.thememanager/files/snapshot/tmp.mtz";

        public f(ApplyThemeForScreenshot applyThemeForScreenshot) {
            super(applyThemeForScreenshot);
        }

        private boolean c(String str) {
            MethodRecorder.i(17746);
            try {
                File file = new File(f54848c);
                if (file.exists()) {
                    file.delete();
                } else {
                    File parentFile = file.getParentFile();
                    if (!parentFile.exists()) {
                        parentFile.mkdirs();
                    }
                }
                Log.d(ApplyThemeForScreenshot.f54815g, "copyMtz2ThemeFile path=" + str);
                FileInputStream fileInputStream = new FileInputStream(str);
                FileOutputStream fileOutputStream = new FileOutputStream(f54848c);
                byte[] bArr = new byte[4096];
                while (true) {
                    int i10 = fileInputStream.read(bArr);
                    if (i10 < 0) {
                        fileOutputStream.flush();
                        fileOutputStream.close();
                        fileInputStream.close();
                        MethodRecorder.o(17746);
                        return true;
                    }
                    fileOutputStream.write(bArr, 0, i10);
                }
            } catch (Exception e10) {
                Log.e(ApplyThemeForScreenshot.f54815g, "copyMtz2ThemeFile fail.", e10);
                MethodRecorder.o(17746);
                return false;
            }
        }

        /* JADX INFO: Access modifiers changed from: protected */
        @Override // com.android.thememanager.activity.ApplyThemeForScreenshot.g, android.os.AsyncTask
        /* JADX INFO: renamed from: a */
        public Resource doInBackground(String... strArr) throws Throwable {
            MethodRecorder.i(17745);
            if (!c(new c(strArr[0]).e())) {
                MethodRecorder.o(17745);
                return null;
            }
            strArr[0] = f54848c;
            Resource resourceDoInBackground = super.doInBackground(f54848c, strArr[1]);
            MethodRecorder.o(17745);
            return resourceDoInBackground;
        }
    }

    /* JADX INFO: compiled from: r8-map-id-15233a4145dd155ba1d32e96c0900a002f8f4134c220df1ca698b809ba9c00e4 */
    private static class g extends AsyncTask<String, Void, Resource> {

        /* JADX INFO: renamed from: a, reason: collision with root package name */
        private ProgressDialog f54849a;

        /* JADX INFO: renamed from: b, reason: collision with root package name */
        protected final SoftReference<ApplyThemeForScreenshot> f54850b;

        public g(ApplyThemeForScreenshot applyThemeForScreenshot) {
            this.f54850b = new SoftReference<>(applyThemeForScreenshot);
        }

        /* JADX INFO: Access modifiers changed from: protected */
        @Override // android.os.AsyncTask
        /* JADX INFO: renamed from: a */
        public Resource doInBackground(String... strArr) throws Throwable {
            MethodRecorder.i(17431);
            ApplyThemeForScreenshot applyThemeForScreenshot = this.f54850b.get();
            if (applyThemeForScreenshot != null) {
                applyThemeForScreenshot.m();
            }
            Resource resourceJ = ApplyThemeForScreenshot.j(strArr[0], strArr[1]);
            MethodRecorder.o(17431);
            return resourceJ;
        }

        /* JADX INFO: Access modifiers changed from: protected */
        @Override // android.os.AsyncTask
        /* JADX INFO: renamed from: b */
        public void onPostExecute(Resource resource) {
            MethodRecorder.i(17432);
            ApplyThemeForScreenshot applyThemeForScreenshot = this.f54850b.get();
            if (applyThemeForScreenshot != null) {
                if (!applyThemeForScreenshot.isFinishing()) {
                    this.f54849a.dismiss();
                }
                if (resource == null && TextUtils.equals(applyThemeForScreenshot.f54829c, "default")) {
                    resource = applyThemeForScreenshot.g();
                }
                applyThemeForScreenshot.f(resource);
            }
            MethodRecorder.o(17432);
        }

        @Override // android.os.AsyncTask
        protected void onPreExecute() {
            MethodRecorder.i(17430);
            ApplyThemeForScreenshot applyThemeForScreenshot = this.f54850b.get();
            if (applyThemeForScreenshot != null) {
                this.f54849a = new ProgressDialog(applyThemeForScreenshot);
                if (applyThemeForScreenshot.isFinishing()) {
                    Log.e(ApplyThemeForScreenshot.f54815g, "ApplyThemeForScreenshot: activity was finished and it shold not occur: " + applyThemeForScreenshot);
                } else {
                    this.f54849a.show();
                }
            }
            MethodRecorder.o(17430);
        }
    }

    /* JADX INFO: Access modifiers changed from: private */
    public void f(Resource resource) {
        MethodRecorder.i(17492);
        if (resource == null) {
            this.f54828b.setText("解压主题包失败: themePath=" + this.f54829c);
            setResult(0);
            finish();
            MethodRecorder.o(17492);
            return;
        }
        if (isFinishing()) {
            MethodRecorder.o(17492);
        } else if (j0.H()) {
            h2.h(R.string.apply_not_support_in_second_space, 0);
            MethodRecorder.o(17492);
        } else {
            new b(this, com.android.thememanager.basemodule.controller.a.e().g().e(this.f54830d), resource, new ApplyThemeInfo().setIgnoreCodeSet(this.f54831e).setIsFromThemeEditor(true), null, resource).executeOnExecutor(com.android.thememanager.basemodule.utils.l.e(), new Void[0]);
            MethodRecorder.o(17492);
        }
    }

    /* JADX INFO: Access modifiers changed from: private */
    public Resource g() {
        MethodRecorder.i(17491);
        Resource resource = new Resource();
        ArrayList arrayList = new ArrayList();
        for (String str : ThemeResourceConstants.Hz) {
            RelatedResource relatedResource = new RelatedResource();
            relatedResource.setResourceCode(str);
            relatedResource.setContentPath("");
            arrayList.add(relatedResource);
        }
        resource.setSubResources(arrayList);
        MethodRecorder.o(17491);
        return resource;
    }

    private long h(String str, long j10) {
        MethodRecorder.i(17490);
        long longExtra = getIntent().getLongExtra(str, j10);
        if (longExtra == j10) {
            longExtra = y0.m(getIntent().getStringExtra(str), Long.valueOf(j10)).longValue();
        }
        MethodRecorder.o(17490);
        return longExtra;
    }

    private void i() {
        MethodRecorder.i(17486);
        Intent intent = new Intent("android.intent.action.GET_CONTENT");
        intent.setType("*/*");
        intent.addCategory("android.intent.category.OPENABLE");
        startActivityForResult(intent, 1);
        h2.h(R.string.editor_apply_toast, 1);
        MethodRecorder.o(17486);
    }

    public static Resource j(String str, String str2) throws Throwable {
        Object obj;
        MethodRecorder.i(17493);
        try {
            String str3 = File.separator;
            if (!str2.endsWith(str3)) {
                str2 = str2 + str3;
            }
            s3.i.E(str2);
            new File(str2).mkdirs();
            ResourceHelper.J0(str, str2, null);
            Resource resource = new Resource();
            com.android.thememanager.basemodule.unzip.a aVar = new com.android.thememanager.basemodule.unzip.a(new File(str2 + "description.xml"));
            resource.setLocalPlatform(aVar.f());
            resource.getLocalInfo().setVersion(aVar.j());
            resource.getLocalInfo().setAuthors(aVar.a());
            resource.getLocalInfo().setDesigners(aVar.c());
            resource.getLocalInfo().setTitles(aVar.i());
            resource.getLocalInfo().setDescriptions(aVar.b());
            i0.s(resource);
            k(str2);
            Map<String, String> mapG = com.android.thememanager.basemodule.utils.e.g();
            ArrayList arrayList = new ArrayList();
            for (String str4 : mapG.keySet()) {
                File file = new File(str2, str4);
                if (file.isFile()) {
                    RelatedResource relatedResource = new RelatedResource();
                    relatedResource.setResourceCode(mapG.get(str4));
                    relatedResource.setContentPath(file.getAbsolutePath());
                    arrayList.add(relatedResource);
                }
            }
            for (File file2 : new File(str2).listFiles()) {
                if (file2.isFile()) {
                    int size = arrayList.size();
                    int i10 = 0;
                    do {
                        if (i10 >= size) {
                            RelatedResource relatedResource2 = new RelatedResource();
                            relatedResource2.setResourceCode(file2.getName());
                            relatedResource2.setContentPath(file2.getAbsolutePath());
                            arrayList.add(relatedResource2);
                            break;
                        }
                        obj = arrayList.get(i10);
                        i10++;
                    } while (!new File(((RelatedResource) obj).getContentPath()).getAbsolutePath().equals(file2.getAbsolutePath()));
                }
            }
            resource.setSubResources(arrayList);
            MethodRecorder.o(17493);
            return resource;
        } catch (Exception e10) {
            e10.printStackTrace();
            MethodRecorder.o(17493);
            return null;
        }
    }

    public static void k(String str) {
        MethodRecorder.i(17494);
        if (new File(str, y1.f62653f).exists()) {
            new File(str, y1.f62653f).renameTo(new File(str, "com.miui.home"));
        }
        File file = new File(str, ThemeResourceConstants.qy);
        if (!file.exists()) {
            for (String str2 : ThemeResourceConstants.Jy) {
                File file2 = new File(str, str2);
                if (file2.exists()) {
                    file.delete();
                    file2.renameTo(file);
                    break;
                }
            }
        }
        File file3 = new File(str, ThemeResourceConstants.ty);
        if (!file3.exists()) {
            for (String str3 : ThemeResourceConstants.Ky) {
                File file4 = new File(str, str3);
                if (file4.exists()) {
                    file3.delete();
                    file4.renameTo(file3);
                    break;
                }
            }
        }
        MethodRecorder.o(17494);
    }

    private static String l(String str, String str2) {
        MethodRecorder.i(17489);
        if (TextUtils.isEmpty(str) || TextUtils.isEmpty(str2)) {
            MethodRecorder.o(17489);
            return null;
        }
        char[] charArray = str.toCharArray();
        char[] charArray2 = (str2 + miuix.appcompat.view.menu.d.f181245a).toCharArray();
        StringBuilder sb2 = new StringBuilder();
        int i10 = 0;
        int i11 = 0;
        while (sb2.length() < 32) {
            sb2.append((char) (charArray2[i10 % charArray2.length] ^ charArray[i11 % charArray.length]));
            i10++;
            i11++;
        }
        String string = sb2.toString();
        MethodRecorder.o(17489);
        return string;
    }

    /* JADX INFO: Access modifiers changed from: private */
    public void m() {
        MethodRecorder.i(com.google.firebase.m.f108300x);
        Account[] accountsByType = AccountManager.get(this).getAccountsByType("com.xiaomi");
        String str = (accountsByType == null || accountsByType.length <= 0) ? "none" : accountsByType[0].name;
        String deviceId = DeviceUtils.getDeviceId(this);
        String str2 = TextUtils.isEmpty(deviceId) ? "none" : deviceId;
        HashMap map = new HashMap();
        map.put("apply_directly_api_called_from", this.f54832f);
        String strK = ResourceHelper.K(this.f54829c);
        if (!TextUtils.isEmpty(strK)) {
            map.put("apply_theme_hash", strK);
            map.put("user_account", l(strK, str));
            map.put("user_imei", l(strK, str2));
            map.put("user_device", Build.DEVICE);
            map.put("user_version", Build.VERSION.RELEASE + "_" + Build.VERSION.INCREMENTAL);
            com.android.thememanager.basemodule.analysis.b.q("Apply.Directly.Api", map);
        }
        n4.b.g(com.android.thememanager.basemodule.analysis.g.A0, "item_id", com.android.thememanager.basemodule.analysis.g.f60009x5, FirebaseAnalytics.b.f106822p, com.android.thememanager.basemodule.analysis.g.f60019y5 + strK);
        MethodRecorder.o(com.google.firebase.m.f108300x);
    }

    @Override // android.app.Activity
    protected void onActivityResult(int i10, int i11, Intent intent) {
        Uri data;
        MethodRecorder.i(17487);
        super.onActivityResult(i10, i11, intent);
        if (intent != null && (data = intent.getData()) != null) {
            new e(this, data).executeOnExecutor(com.android.thememanager.basemodule.utils.l.e(), getCacheDir().getAbsolutePath() + RemoteSettings.f109300i, this.f54827a);
        }
        MethodRecorder.o(17487);
    }

    @Override // android.app.Activity
    protected void onCreate(Bundle bundle) {
        EventRecorder.a(2, "com/android/thememanager/activity/ApplyThemeForScreenshot", "onCreate");
        int i10 = 17485;
        MethodRecorder.i(17485);
        LifeCycleRecorder.onTraceBegin(2, "com/android/thememanager/activity/ApplyThemeForScreenshot", "onCreate");
        super.onCreate(bundle);
        int i11 = 0;
        if (bundle != null && bundle.getBoolean(f54816h, false)) {
            Log.i(f54815g, "Applying config change: finish");
            finish();
            LifeCycleRecorder.onTraceEnd(2, "com/android/thememanager/activity/ApplyThemeForScreenshot", "onCreate");
            MethodRecorder.o(17485);
            return;
        }
        this.f54827a = getCacheDir().getAbsolutePath() + "tmp_unzip_folder/";
        this.f54829c = getIntent().getStringExtra(f54819k);
        long jH = h(f54820l, -1L);
        long jH2 = h(f54821m, -1L);
        long j10 = ~(jH | jH2);
        String strA = com.android.thememanager.basemodule.utils.e.a(y1.w(jH));
        this.f54830d = strA;
        if (TextUtils.isEmpty(strA)) {
            Log.i(f54815g, "undefine resourceCode, Going to finish");
            finish();
            LifeCycleRecorder.onTraceEnd(2, "com/android/thememanager/activity/ApplyThemeForScreenshot", "onCreate");
            MethodRecorder.o(17485);
            return;
        }
        this.f54831e.clear();
        if ("theme".equals(this.f54830d)) {
            String[] strArr = ThemeResourceConstants.Hz;
            int length = strArr.length;
            while (i11 < length) {
                String str = strArr[i11];
                if ((com.android.thememanager.basemodule.utils.e.o(str) & j10) != 0) {
                    this.f54831e.add(str);
                }
                i11++;
                i10 = i10;
            }
        }
        int i12 = i10;
        TextView textView = new TextView(this);
        this.f54828b = textView;
        textView.setGravity(17);
        this.f54828b.setTextSize(30.0f);
        this.f54828b.setText(com.android.thememanager.basemodule.utils.y.m(R.string.editor_apply_message) + "\n\n" + this.f54829c);
        setContentView(this.f54828b);
        String stringExtra = getIntent().getStringExtra(f54822n);
        this.f54832f = stringExtra;
        if (TextUtils.isEmpty(stringExtra)) {
            this.f54828b.setText("没有设置来源!");
            finish();
            LifeCycleRecorder.onTraceEnd(2, "com/android/thememanager/activity/ApplyThemeForScreenshot", "onCreate");
            MethodRecorder.o(i12);
            return;
        }
        String stringExtra2 = getIntent().getStringExtra(f54823o);
        Log.i(f54815g, "ThemeManger.ApplyThemeForScreenshot: themePath=" + this.f54829c + " ver2_step=" + stringExtra2 + " applyFlags=0x" + Long.toHexString(jH) + " removeFlags=0x" + Long.toHexString(jH2));
        if (TextUtils.equals(f54824p, stringExtra2)) {
            new a().executeOnExecutor(com.android.thememanager.basemodule.utils.l.e(), this.f54829c, stringExtra2);
        } else if (TextUtils.equals(f54825q, stringExtra2)) {
            new f(this).executeOnExecutor(com.android.thememanager.basemodule.utils.l.e(), this.f54829c, this.f54827a);
        } else if (new File(this.f54829c).canRead()) {
            new g(this).executeOnExecutor(com.android.thememanager.basemodule.utils.l.e(), this.f54829c, this.f54827a);
        } else {
            i();
        }
        LifeCycleRecorder.onTraceEnd(2, "com/android/thememanager/activity/ApplyThemeForScreenshot", "onCreate");
        MethodRecorder.o(i12);
    }

    @Override // android.app.Activity
    protected void onSaveInstanceState(Bundle bundle) {
        MethodRecorder.i(17488);
        super.onSaveInstanceState(bundle);
        bundle.putBoolean(f54816h, isFinishing());
        MethodRecorder.o(17488);
    }
}
