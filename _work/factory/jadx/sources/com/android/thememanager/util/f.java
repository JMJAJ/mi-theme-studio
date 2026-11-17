package com.android.thememanager.util;

import android.app.Activity;
import android.app.WallpaperInfo;
import android.app.WallpaperManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.AsyncTask;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.provider.Settings;
import android.system.Os;
import android.system.StructStat;
import android.text.TextUtils;
import android.util.Log;
import com.android.thememanager.R;
import com.android.thememanager.basemodule.model.RelatedResourceResolver;
import com.android.thememanager.basemodule.model.ResourceContext;
import com.android.thememanager.basemodule.model.ResourceResolver;
import com.android.thememanager.basemodule.model.ThemeFilePath;
import com.android.thememanager.basemodule.model.v9.TrackInfo;
import com.android.thememanager.basemodule.resource.ResourceHelper;
import com.android.thememanager.basemodule.resource.constants.ThemeResourceConstants;
import com.android.thememanager.basemodule.resource.model.ApplyThemeInfo;
import com.android.thememanager.basemodule.resource.model.RelatedResource;
import com.android.thememanager.basemodule.resource.model.Resource;
import com.android.thememanager.basemodule.ringtone.RingtoneMeta;
import com.android.thememanager.basemodule.ui.BaseActivity;
import com.android.thememanager.basemodule.utils.b2;
import com.android.thememanager.basemodule.utils.c3;
import com.android.thememanager.basemodule.utils.q2;
import com.android.thememanager.basemodule.utils.wallpaper.LockscreenWallpaperHelper;
import com.android.thememanager.basemodule.utils.y1;
import com.android.thememanager.largeicon.LargeIconRuntimeManager;
import com.android.thememanager.model.WallpaperApplyInfos;
import com.android.thememanager.service.ThemeSchedulerService;
import com.google.firebase.analytics.FirebaseAnalytics;
import com.google.firebase.sessions.settings.RemoteSettings;
import com.miui.keyguard.editor.settings.data.CurrentTemplateDataSource;
import com.miui.maml.folme.AnimatedProperty;
import com.miui.miapm.block.core.MethodRecorder;
import com.personalizedEditor.helper.SettingHelper;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.lang.ref.WeakReference;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.OpenOption;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import miui.content.res.IconCustomizer;
import miui.content.res.ThemeResources;
import miui.content.res.ThemeResourcesSystem;

/* JADX INFO: compiled from: r8-map-id-15233a4145dd155ba1d32e96c0900a002f8f4134c220df1ca698b809ba9c00e4 */
/* JADX INFO: loaded from: classes7.dex */
public class f extends AsyncTask<Void, Integer, String> implements com.android.thememanager.basemodule.resource.constants.e, ThemeResourceConstants {

    /* JADX INFO: renamed from: r, reason: collision with root package name */
    private static final String f78962r = "ApplyThemeTask";

    /* JADX INFO: renamed from: s, reason: collision with root package name */
    private static final long f78963s = 1000;

    /* JADX INFO: renamed from: t, reason: collision with root package name */
    public static final String f78964t = "content://miui.keyguard.editor.templatefileprovider/thirdPartyPreviewImage";

    /* JADX INFO: renamed from: a, reason: collision with root package name */
    private WeakReference<Context> f78965a;

    /* JADX INFO: renamed from: b, reason: collision with root package name */
    private ResourceContext f78966b;

    /* JADX INFO: renamed from: c, reason: collision with root package name */
    private miuix.appcompat.app.d1 f78967c;

    /* JADX INFO: renamed from: d, reason: collision with root package name */
    private int f78968d;

    /* JADX INFO: renamed from: e, reason: collision with root package name */
    private long f78969e;

    /* JADX INFO: renamed from: f, reason: collision with root package name */
    private Resource f78970f;

    /* JADX INFO: renamed from: h, reason: collision with root package name */
    private ApplyThemeInfo f78972h;

    /* JADX INFO: renamed from: i, reason: collision with root package name */
    private String f78973i;

    /* JADX INFO: renamed from: j, reason: collision with root package name */
    private Runnable f78974j;

    /* JADX INFO: renamed from: k, reason: collision with root package name */
    private String f78975k;

    /* JADX INFO: renamed from: l, reason: collision with root package name */
    private TrackInfo f78976l;

    /* JADX INFO: renamed from: m, reason: collision with root package name */
    androidx.lifecycle.k0<Boolean> f78977m;

    /* JADX INFO: renamed from: n, reason: collision with root package name */
    private String f78978n;

    /* JADX INFO: renamed from: g, reason: collision with root package name */
    private Set<String> f78971g = new HashSet();

    /* JADX INFO: renamed from: o, reason: collision with root package name */
    private String f78979o = "";

    /* JADX INFO: renamed from: p, reason: collision with root package name */
    private boolean f78980p = false;

    /* JADX INFO: renamed from: q, reason: collision with root package name */
    private boolean f78981q = false;

    public f(Context context, ResourceContext resourceContext, Resource resource, ApplyThemeInfo applyThemeInfo, androidx.lifecycle.k0<Boolean> k0Var) {
        this.f78965a = new WeakReference<>(context);
        this.f78966b = resourceContext;
        this.f78970f = resource;
        this.f78972h = applyThemeInfo;
        TrackInfo trackInfoCreate = applyThemeInfo.getTrackInfo() == null ? TrackInfo.create() : applyThemeInfo.getTrackInfo();
        this.f78976l = trackInfoCreate;
        trackInfoCreate.resourceToTrackInfo(this.f78970f);
        this.f78973i = applyThemeInfo.getApplyThemeMessage();
        this.f78975k = applyThemeInfo.getThemeUsingType();
        this.f78977m = k0Var;
        String resourceCode = resourceContext.getResourceCode();
        if ("theme".equals(resourceCode)) {
            this.f78971g.addAll(Arrays.asList(ThemeResourceConstants.Hz));
            this.f78971g.add(com.android.thememanager.basemodule.analysis.a.Pq);
            if (com.android.thememanager.basemodule.utils.j0.D()) {
                this.f78971g.add("miui.systemui.plugin");
            }
            b2.h(applyThemeInfo.getIgnoreCodeSet());
            String str = ThemeResourceConstants.hz + miuix.core.util.e.f(new ResourceResolver(resource, resourceContext).getRightsPath());
            b2.z("theme", new ResourceResolver(resource, resourceContext).getMetaPath(), str, resource.getLocalId(), resource.getTitle(), resource.getHash(), y1.u(resourceContext, resource));
            f0.a(resource, resourceContext);
            this.f78978n = str;
        } else {
            this.f78971g.add(resourceCode);
            if ("lockstyle".equals(resourceCode)) {
                this.f78971g.add("lockscreen");
            }
            this.f78971g.addAll(applyThemeInfo.getRelatedCodeSet());
        }
        if (applyThemeInfo.getIgnoreCodeSet() != null) {
            this.f78971g.removeAll(applyThemeInfo.getIgnoreCodeSet());
        }
        s3.k.u(y1.u(resourceContext, resource), resource.getTitle(), System.currentTimeMillis(), this.f78975k, resourceContext.getResourceStamp());
    }

    private boolean A(@androidx.annotation.n0 Set<String> set) {
        MethodRecorder.i(17863);
        if (set.size() == 1 && set.contains(ThemeResourceConstants.vz)) {
            MethodRecorder.o(17863);
            return false;
        }
        if (set.size() == 1 && set.contains("fonts") && this.f78974j != null) {
            Log.i(f78962r, "var fonts changed, notify already!");
        } else {
            d4.a.b(com.android.thememanager.basemodule.controller.a.e().c(), y1.s(set));
        }
        MethodRecorder.o(17863);
        return true;
    }

    /* JADX WARN: Code duplicated, block: B:63:0x00cd A[Catch: Exception -> 0x00c9, EDGE_INSN: B:63:0x00cd->B:83:0x00f8 BREAK  A[LOOP:0: B:20:0x0056->B:100:?], PHI: r3
  0x00cd: PHI (r3v5 java.io.FileInputStream) = (r3v4 java.io.FileInputStream), (r3v9 java.io.FileInputStream) binds: [B:70:0x00dd, B:62:0x00cb] A[DONT_GENERATE, DONT_INLINE], TRY_LEAVE, TryCatch #5 {Exception -> 0x00c9, blocks: (B:59:0x00c5, B:63:0x00cd, B:69:0x00da), top: B:88:0x0077, outer: #11 }] */
    /* JADX WARN: Code duplicated, block: B:69:0x00da A[Catch: Exception -> 0x00c9, TRY_ENTER, TRY_LEAVE, TryCatch #5 {Exception -> 0x00c9, blocks: (B:59:0x00c5, B:63:0x00cd, B:69:0x00da), top: B:88:0x0077, outer: #11 }] */
    private void B(boolean z10) throws Throwable {
        FileInputStream fileInputStream;
        MethodRecorder.i(17891);
        try {
            if (!com.android.thememanager.basemodule.utils.j0.A()) {
                MethodRecorder.o(17891);
                return;
            }
            if (z10 && com.android.thememanager.basemodule.utils.wallpaper.v.w().p() && !com.android.thememanager.basemodule.utils.wallpaper.x.i() && this.f78971g.contains("lockscreen")) {
                SettingHelper.f134849a.l();
            }
            if (this.f78971g.contains("lockstyle")) {
                com.android.thememanager.basemodule.utils.lockscreen.d.n();
                for (String str : new ResourceResolver(this.f78970f, this.f78966b.getThemeFilePath()).getBuildInPreviews()) {
                    if (str.contains("_lockscreen_")) {
                        if (Build.VERSION.SDK_INT < 29) {
                            break;
                        }
                        Uri uri = Uri.parse("content://miui.keyguard.editor.templatefileprovider/thirdPartyPreviewImage");
                        ParcelFileDescriptor.AutoCloseOutputStream autoCloseOutputStream = null;
                        try {
                            try {
                                try {
                                    if (new File(str).exists()) {
                                        fileInputStream = new FileInputStream(str);
                                        try {
                                            ParcelFileDescriptor.AutoCloseOutputStream autoCloseOutputStream2 = new ParcelFileDescriptor.AutoCloseOutputStream(com.android.thememanager.basemodule.controller.a.a().getContentResolver().openFile(uri, AnimatedProperty.PROPERTY_NAME_W, null));
                                            try {
                                                byte[] bArr = new byte[8192];
                                                while (true) {
                                                    int i10 = fileInputStream.read(bArr);
                                                    if (i10 == -1) {
                                                        break;
                                                    } else {
                                                        autoCloseOutputStream2.write(bArr, 0, i10);
                                                    }
                                                }
                                                autoCloseOutputStream = autoCloseOutputStream2;
                                            } catch (Error e10) {
                                                e = e10;
                                                autoCloseOutputStream = autoCloseOutputStream2;
                                                e.printStackTrace();
                                                if (autoCloseOutputStream != null) {
                                                    autoCloseOutputStream.close();
                                                }
                                                if (fileInputStream != null) {
                                                    break;
                                                } else {
                                                    break;
                                                }
                                                MethodRecorder.o(17891);
                                            } catch (Exception e11) {
                                                e = e11;
                                                autoCloseOutputStream = autoCloseOutputStream2;
                                                e.printStackTrace();
                                                if (autoCloseOutputStream != null) {
                                                    autoCloseOutputStream.close();
                                                }
                                                if (fileInputStream != null) {
                                                    break;
                                                } else {
                                                    break;
                                                }
                                                MethodRecorder.o(17891);
                                            } catch (Throwable th) {
                                                th = th;
                                                autoCloseOutputStream = autoCloseOutputStream2;
                                                if (autoCloseOutputStream != null) {
                                                    try {
                                                        autoCloseOutputStream.close();
                                                    } catch (Exception e12) {
                                                        e12.printStackTrace();
                                                        MethodRecorder.o(17891);
                                                        throw th;
                                                    }
                                                }
                                                if (fileInputStream != null) {
                                                    fileInputStream.close();
                                                }
                                                MethodRecorder.o(17891);
                                                throw th;
                                            }
                                        } catch (Error e13) {
                                            e = e13;
                                        } catch (Exception e14) {
                                            e = e14;
                                        }
                                    } else {
                                        fileInputStream = null;
                                    }
                                    if (autoCloseOutputStream != null) {
                                        autoCloseOutputStream.close();
                                    }
                                    if (fileInputStream == null) {
                                        break;
                                    }
                                    fileInputStream.close();
                                    break;
                                } catch (Throwable th2) {
                                    th = th2;
                                }
                            } catch (Error e15) {
                                e = e15;
                                fileInputStream = null;
                                e.printStackTrace();
                                if (autoCloseOutputStream != null) {
                                    autoCloseOutputStream.close();
                                }
                                if (fileInputStream != null) {
                                    break;
                                }
                                fileInputStream.close();
                                break;
                                MethodRecorder.o(17891);
                            } catch (Exception e16) {
                                e = e16;
                                fileInputStream = null;
                                e.printStackTrace();
                                if (autoCloseOutputStream != null) {
                                    autoCloseOutputStream.close();
                                }
                                if (fileInputStream != null) {
                                    break;
                                }
                                fileInputStream.close();
                                break;
                                MethodRecorder.o(17891);
                            } catch (Throwable th3) {
                                th = th3;
                                fileInputStream = null;
                            }
                        } catch (Exception e17) {
                            e17.printStackTrace();
                            break;
                        }
                    }
                }
            }
        } catch (Exception e18) {
            e18.printStackTrace();
        }
        MethodRecorder.o(17891);
    }

    private void F() {
        MethodRecorder.i(17880);
        Log.e(com.android.thememanager.basemodule.utils.c1.f61769n, "copy right file failed!");
        File file = new File(ThemeResourceConstants.hz);
        if (!file.exists()) {
            com.android.thememanager.basemodule.analysis.f.q(com.android.thememanager.basemodule.analysis.g.A0, "item_id", "theme_apply", FirebaseAnalytics.b.f106822p, "ta_5");
        } else if (file.canWrite()) {
            com.android.thememanager.basemodule.analysis.f.q(com.android.thememanager.basemodule.analysis.g.A0, "item_id", "theme_apply", FirebaseAnalytics.b.f106822p, "ta_3_" + com.android.thememanager.basemodule.utils.j0.H());
        } else {
            Log.i(com.android.thememanager.basemodule.utils.c1.f61769n, "rights dir is not writable.");
            com.android.thememanager.basemodule.analysis.f.q(com.android.thememanager.basemodule.analysis.g.A0, "item_id", "theme_apply", FirebaseAnalytics.b.f106822p, "ta_4");
        }
        MethodRecorder.o(17880);
    }

    private int G(int i10, int i11) {
        MethodRecorder.i(17867);
        int i12 = i10 + i11;
        publishProgress(Integer.valueOf(i12));
        MethodRecorder.o(17867);
        return i12;
    }

    private void H(Resource resource, Set<String> set, InputStream inputStream) {
        SettingHelper.ResourceSourceForLockWallpaper resourceSourceForLockWallpaper;
        String str;
        MethodRecorder.i(17870);
        if (com.android.thememanager.basemodule.utils.j0.D()) {
            String str2 = null;
            if (inputStream == null) {
                if (y1.A(this.f78966b.getResourceCode(), resource.getMetaPath())) {
                    resourceSourceForLockWallpaper = SettingHelper.ResourceSourceForLockWallpaper.THEME_DEFAULT;
                } else {
                    resourceSourceForLockWallpaper = SettingHelper.ResourceSourceForLockWallpaper.THEME_NORMAL;
                    str2 = com.android.thememanager.basemodule.resource.constants.b.U;
                }
                str = str2;
                f(this.f78979o);
            } else {
                resourceSourceForLockWallpaper = SettingHelper.ResourceSourceForLockWallpaper.THEME_MAML_LOCK;
                str = null;
            }
            SettingHelper.f134849a.m(s(inputStream, set), str2, str, resourceSourceForLockWallpaper);
        }
        MethodRecorder.o(17870);
    }

    /* JADX WARN: Code duplicated, block: B:207:0x0510  */
    /* JADX WARN: Multi-variable type inference failed */
    /* JADX WARN: Type inference failed for: r0v111 */
    /* JADX WARN: Type inference failed for: r0v51 */
    /* JADX WARN: Type inference failed for: r0v52 */
    /* JADX WARN: Type inference failed for: r6v16 */
    /* JADX WARN: Type inference failed for: r6v17, types: [int] */
    /* JADX WARN: Type inference failed for: r6v19 */
    /* JADX WARN: Type inference failed for: r6v20, types: [int] */
    /* JADX WARN: Type inference failed for: r6v29 */
    /* JADX WARN: Type inference failed for: r6v30 */
    /* JADX WARN: Type inference failed for: r9v22 */
    /* JADX WARN: Type inference failed for: r9v23, types: [int] */
    /* JADX WARN: Type inference failed for: r9v27 */
    private void a(Resource resource, ResourceContext resourceContext, Set<String> set) throws Throwable {
        int i10;
        boolean z10;
        String localId;
        byte b10;
        char c10;
        InputStream inputStreamP;
        InputStream inputStreamNewInputStream;
        String strR;
        MethodRecorder.i(17869);
        Context contextC = com.android.thememanager.basemodule.controller.a.e().c();
        if (contextC == null) {
            MethodRecorder.o(17869);
            return;
        }
        boolean z11 = ApplyThemeInfo.THEME_USING_TYPE_RESTORE.equals(this.f78975k) || ApplyThemeInfo.THEME_USING_TYPE_FORCE_RESTORE.equals(this.f78975k);
        boolean z12 = ApplyThemeInfo.THEME_USING_TYPE_PROVISION.equals(this.f78975k) && z0.a();
        com.android.thememanager.basemodule.utils.a.c();
        this.f78968d = G(this.f78968d, 1);
        if (m(contextC)) {
            com.android.thememanager.basemodule.utils.a.b();
        }
        if (new File(y1.q()).exists() && (strR = y1.r("lockstyle", s3.k.f("lockstyle"))) != null) {
            s3.i.h(y1.q(), strR);
        }
        this.f78968d = G(this.f78968d, 1);
        if (!z11) {
            s3.i.C(y0.f79237a);
        }
        String str = ThemeResourceConstants.hz;
        File file = new File(str);
        if (file.exists()) {
            i10 = 17869;
            if (file.canWrite()) {
                z10 = false;
                if (d3.e.h().fixPermissionAlways) {
                }
            } else {
                Log.e(com.android.thememanager.basemodule.utils.c1.f61769n, "runtime rights dir is not writable");
                z10 = false;
                com.android.thememanager.basemodule.analysis.f.q(com.android.thememanager.basemodule.analysis.g.A0, "item_id", "theme_apply", FirebaseAnalytics.b.f106822p, "ta_1_" + (j3.e.h() ? "2" : "1"));
            }
            Log.i(com.android.thememanager.basemodule.utils.c1.f61769n, "update runtime rights dir permission");
            s3.i.I(str);
            File[] fileArrListFiles = file.listFiles();
            if (fileArrListFiles != null) {
                int length = fileArrListFiles.length;
                for (?? r10 = z10; r10 < length; r10++) {
                    s3.i.I(fileArrListFiles[r10].getAbsolutePath());
                }
            }
            if (!file.canWrite()) {
                Log.e(com.android.thememanager.basemodule.utils.c1.f61769n, "runtime rights dir is not writable after fix");
                com.android.thememanager.basemodule.analysis.f.q(com.android.thememanager.basemodule.analysis.g.A0, "item_id", "theme_apply", FirebaseAnalytics.b.f106822p, "ta_2");
            }
        } else {
            i10 = 17869;
            z10 = false;
        }
        File file2 = new File(com.android.thememanager.basemodule.resource.constants.d.Nv + ThemeResourceConstants.dy);
        if (file2.exists()) {
            if (!file2.canWrite()) {
                Log.e(com.android.thememanager.basemodule.utils.c1.f61769n, "runtime boots dir is not writable");
            } else if (d3.e.h().fixPermissionAlways) {
            }
            Log.i(com.android.thememanager.basemodule.utils.c1.f61769n, "update runtime boots dir permission");
            s3.i.I(file2.getAbsolutePath());
            File[] fileArrListFiles2 = file2.listFiles();
            if (fileArrListFiles2 != null) {
                int length2 = fileArrListFiles2.length;
                for (?? r11 = z10; r11 < length2; r11++) {
                    s3.i.I(fileArrListFiles2[r11].getAbsolutePath());
                }
            }
        }
        File file3 = new File(com.android.thememanager.basemodule.resource.constants.d.Nv + "fonts");
        if (file3.exists()) {
            if (!file3.canWrite()) {
                Log.e(com.android.thememanager.basemodule.utils.c1.f61769n, "runtime fonts dir is not writable");
            } else if (d3.e.h().fixPermissionAlways) {
            }
            Log.i(com.android.thememanager.basemodule.utils.c1.f61769n, "update runtime fonts dir permission");
            s3.i.I(file3.getAbsolutePath());
            File[] fileArrListFiles3 = file3.listFiles();
            if (fileArrListFiles3 != null) {
                int length3 = fileArrListFiles3.length;
                for (?? r12 = z10; r12 < length3; r12++) {
                    s3.i.I(fileArrListFiles3[r12].getAbsolutePath());
                }
            }
        }
        l(r(set));
        com.android.thememanager.basemodule.miuixcompat.h.d(set, resource);
        this.f78968d = G(this.f78968d, 1);
        if (new File(ThemeResourceConstants.PB).exists()) {
            ResourceResolver resourceResolver = new ResourceResolver(resource, this.f78966b);
            if (set.contains("bootanimation")) {
                if (t("bootanimation", resourceResolver.getContentPath())) {
                    s3.i.C(ThemeResourceConstants.QB);
                } else {
                    String str2 = ThemeResourceConstants.QB;
                    s3.i.B(str2);
                    s3.i.I(str2);
                }
            }
            if (set.contains("bootaudio")) {
                if (t("bootaudio", resourceResolver.getContentPath())) {
                    s3.i.C(ThemeResourceConstants.RB);
                } else {
                    String str3 = ThemeResourceConstants.RB;
                    s3.i.B(str3);
                    s3.i.I(str3);
                }
            }
        }
        com.android.thememanager.basemodule.utils.a.a();
        this.f78968d = G(this.f78968d, 1);
        if (com.android.thememanager.basemodule.utils.j0.E() && (set.contains("miwallpaper") || set.contains(ThemeResourceConstants.Ey) || set.contains(ThemeResourceConstants.Fy))) {
            Iterator<RelatedResource> it = resource.getSubResources().iterator();
            while (it.hasNext()) {
                String resourceCode = it.next().getResourceCode();
                if ("miwallpaper".equals(resourceCode) || ThemeResourceConstants.Ey.equals(resourceCode) || ThemeResourceConstants.Fy.equals(resourceCode)) {
                    this.f78980p = true;
                    break;
                }
            }
        }
        String contentPath = "";
        if (!set.contains("lockstyle")) {
            localId = "";
            break;
        }
        Iterator<RelatedResource> it2 = resource.getSubResources().iterator();
        while (true) {
            if (!it2.hasNext()) {
                localId = "";
                break;
            }
            RelatedResource next = it2.next();
            if ("lockstyle".equals(next.getResourceCode())) {
                localId = next.getLocalId();
                if (!com.android.thememanager.basemodule.utils.j0.E()) {
                    break;
                }
                CurrentTemplateDataSource.f127682e.c(true);
                this.f78981q = true;
                break;
            }
        }
        Log.d(f78962r, "isDeskMaml:" + this.f78980p + ",isLockMaml:" + this.f78981q);
        g(resource, resourceContext, set);
        if (ApplyThemeInfo.THEME_USING_TYPE_RESTORE.equals(this.f78975k) || ApplyThemeInfo.THEME_USING_TYPE_FORCE_RESTORE.equals(this.f78975k)) {
            y0.a(contextC);
            this.f78968d = G(this.f78968d, 10);
        }
        e(set);
        this.f78968d = G(this.f78968d, 1);
        set.contains(ThemeResourceConstants.By);
        this.f78968d = G(this.f78968d, 1);
        if (set.contains(ThemeResourceConstants.VA)) {
            if (com.android.thememanager.basemodule.utils.device.a.n0()) {
                LargeIconRuntimeManager.c(com.android.thememanager.basemodule.utils.device.a.j(z10)).g().a().l();
            }
            ThemeResourcesSystem system = ThemeResources.getSystem();
            if (system != null) {
                system.resetIcons();
            }
            this.f78968d = G(this.f78968d, 1);
            IconCustomizer.clearCustomizedIcons((String) null);
            y1.X();
            this.f78968d = G(this.f78968d, 1);
        }
        if (set.contains("lockstyle")) {
            String strR2 = y1.r("lockstyle", localId);
            if (strR2 != null && new File(strR2).exists()) {
                s3.i.h(strR2, y1.q());
            }
            s3.k.r("lockstyle", localId);
        }
        if (set.contains("lockstyle") || set.contains("lockscreen")) {
            if (!z12) {
                if (y1.A(this.f78966b.getResourceCode(), this.f78970f.getMetaPath())) {
                    com.android.thememanager.basemodule.utils.wallpaper.x.y("com.miui.home.none_provider");
                    contextC.sendBroadcast(new Intent(miuix.android.content.b.f179201b));
                } else {
                    com.android.thememanager.basemodule.utils.wallpaper.x.y(ThemeResourceConstants.XB);
                }
            }
            String str4 = ThemeResourceConstants.Vy;
            if (new File(str4).exists()) {
                String str5 = ThemeResources.THEME_MAGIC_PATH + "lockscreen_audio/";
                File file4 = new File(str5);
                if (file4.exists()) {
                    file4.delete();
                }
                miuix.core.util.e.j(file4, 493, -1, -1);
                if (file4.exists()) {
                    ZipFile zipFile = new ZipFile(str4);
                    Enumeration<? extends ZipEntry> enumerationEntries = zipFile.entries();
                    while (enumerationEntries.hasMoreElements()) {
                        ZipEntry zipEntryNextElement = enumerationEntries.nextElement();
                        String name = zipEntryNextElement.getName();
                        if (!name.contains("../")) {
                            String lowerCase = name.toLowerCase();
                            if (lowerCase.endsWith(com.android.thememanager.basemodule.resource.constants.c.Wu) || lowerCase.endsWith(".ogg") || lowerCase.endsWith(".aac") || lowerCase.endsWith(".wav") || lowerCase.endsWith(".midi")) {
                                InputStream inputStream = zipFile.getInputStream(zipEntryNextElement);
                                File file5 = new File(str5 + name);
                                b10 = -1;
                                c10 = 493;
                                if (miuix.core.util.e.j(file5.getParentFile(), 493, -1, -1)) {
                                    miuix.core.util.e.d(inputStream, file5);
                                    s3.i.d(file5.getAbsolutePath(), 493);
                                }
                                miuix.core.util.j.b(inputStream);
                            } else {
                                b10 = -1;
                                c10 = 493;
                            }
                            str5 = str5;
                        }
                    }
                }
            }
        }
        this.f78968d = G(this.f78968d, 1);
        if (set.contains("miwallpaper")) {
            String str6 = ThemeResourceConstants.dz;
            if (new File(str6).exists()) {
                try {
                    ZipFile zipFile2 = new ZipFile(str6);
                    if (!z12 && (zipFile2.getEntry(ThemeResourceConstants.iC) != null || zipFile2.getEntry(ThemeResourceConstants.jC) != null)) {
                        com.android.thememanager.basemodule.utils.wallpaper.x.y(ThemeResourceConstants.YB);
                    }
                } catch (Exception e10) {
                    e10.printStackTrace();
                }
                WallpaperManager wallpaperManager = WallpaperManager.getInstance(contextC);
                WallpaperInfo wallpaperInfo = wallpaperManager.getWallpaperInfo();
                if ((wallpaperInfo == null || !"com.miui.miwallpaper.MiWallpaper".equals(wallpaperInfo.getServiceName())) && !com.android.thememanager.basemodule.utils.wallpaper.v.w().p()) {
                    com.android.thememanager.basemodule.utils.z.k(wallpaperManager, new ComponentName("com.miui.miwallpaper", "com.miui.miwallpaper.MiWallpaper"));
                }
                Intent intent = new Intent(com.android.thememanager.basemodule.resource.constants.e.Pw);
                intent.putExtra(com.android.thememanager.basemodule.resource.constants.e.fx, z10);
                contextC.sendBroadcast(intent);
                try {
                    inputStreamP = p(new ResourceResolver(resource, this.f78966b).getBuildInPreviews());
                } catch (Exception e11) {
                    Log.e(f78962r, "miWallpaper preview inputStream exception : ", e11);
                    inputStreamP = null;
                }
            } else {
                inputStreamP = null;
            }
        } else {
            inputStreamP = null;
        }
        this.f78968d = G(this.f78968d, 1);
        if (set.contains(androidx.core.app.w.K0)) {
            Settings.System.putString(contextC.getContentResolver(), miuix.provider.a.b.f190352a, resource.getTitle());
        }
        if (set.contains("alarmscreen")) {
            for (RelatedResource relatedResource : resource.getSubResources()) {
                if (relatedResource.getResourceCode().equals("alarmscreen")) {
                    contentPath = new RelatedResourceResolver(relatedResource, this.f78966b).getContentPath();
                    break;
                }
            }
            Settings.System.putString(contextC.getContentResolver(), miuix.provider.a.b.f190352a, contentPath);
        }
        this.f78968d = G(this.f78968d, 1);
        b2.i(true);
        h(resource, set);
        if (com.android.thememanager.basemodule.utils.wallpaper.v.w().p() && !TextUtils.isEmpty(this.f78979o) && com.android.thememanager.basemodule.utils.wallpaper.x.i() && this.f78971g.contains("lockstyle")) {
            try {
                inputStreamNewInputStream = Files.newInputStream(Paths.get(this.f78979o, new String[0]), new OpenOption[0]);
            } catch (Exception e12) {
                Log.e(f78962r, "MAML apply lock by InputStream fail", e12);
                inputStreamNewInputStream = null;
            }
        } else {
            inputStreamNewInputStream = null;
        }
        if (com.android.thememanager.basemodule.utils.j0.E()) {
            CurrentTemplateDataSource.f127682e.c(false);
        }
        int iK = (this.f78971g.contains("lockstyle") ? SettingHelper.f134849a.k() : 1) ^ 1;
        if (!c3.e() || inputStreamNewInputStream == null || inputStreamP == null) {
            if (inputStreamP != null) {
                WallpaperApplyInfos wallpaperApplyInfos = new WallpaperApplyInfos(1, true);
                wallpaperApplyInfos.setDoodleStatus(iK);
                com.android.thememanager.basemodule.utils.wallpaper.v.w().f(inputStreamP, wallpaperApplyInfos);
            }
            if (inputStreamNewInputStream != null) {
                WallpaperApplyInfos wallpaperApplyInfos2 = new WallpaperApplyInfos(2, true);
                wallpaperApplyInfos2.setDoodleStatus(iK);
                com.android.thememanager.basemodule.utils.wallpaper.v.w().f(inputStreamNewInputStream, wallpaperApplyInfos2);
            }
        } else {
            WallpaperApplyInfos wallpaperApplyInfos3 = new WallpaperApplyInfos(com.miui.miwallpaper.q.U, true);
            wallpaperApplyInfos3.setDoodleStatus(iK);
            com.android.thememanager.basemodule.utils.wallpaper.v.w().g(inputStreamP, inputStreamNewInputStream, wallpaperApplyInfos3);
        }
        this.f78968d = G(this.f78968d, 1);
        H(resource, set, inputStreamNewInputStream);
        this.f78968d = G(100, 0);
        MethodRecorder.o(i10);
    }

    private void b(List<RelatedResource> list, Set<String> set, ResourceContext resourceContext) {
        String metaPath;
        Resource systemInitialResource;
        MethodRecorder.i(17877);
        Context contextA = com.android.thememanager.basemodule.controller.a.a();
        for (String str : ThemeResourceConstants.Yx) {
            if (set.contains(str)) {
                Iterator<RelatedResource> it = list.iterator();
                while (true) {
                    if (!it.hasNext()) {
                        metaPath = "";
                        break;
                    }
                    RelatedResource next = it.next();
                    if (str.equals(next.getResourceCode())) {
                        metaPath = new RelatedResourceResolver(next, this.f78966b).getContentPath();
                        break;
                    }
                }
                RingtoneMeta ringtoneMetaFromResourceCode = RingtoneMeta.getRingtoneMetaFromResourceCode(str);
                if (ringtoneMetaFromResourceCode != null) {
                    if (!new File(metaPath).exists() && (systemInitialResource = ringtoneMetaFromResourceCode.getSystemInitialResource()) != null) {
                        metaPath = systemInitialResource.getMetaPath();
                    }
                    if (!TextUtils.isEmpty(metaPath)) {
                        com.android.thememanager.basemodule.ringtone.p.j(resourceContext, ringtoneMetaFromResourceCode, metaPath, contextA);
                    }
                }
            }
        }
        MethodRecorder.o(17877);
    }

    private void c(List<RelatedResource> list, ThemeFilePath themeFilePath, Set<String> set, int i10) throws Throwable {
        MethodRecorder.i(17878);
        Context contextA = com.android.thememanager.basemodule.controller.a.a();
        RelatedResourceResolver relatedResourceResolver = null;
        RelatedResourceResolver relatedResourceResolver2 = null;
        for (RelatedResource relatedResource : list) {
            if ("wallpaper".equals(relatedResource.getResourceCode())) {
                relatedResourceResolver = new RelatedResourceResolver(relatedResource, themeFilePath);
            } else if ("lockscreen".equals(relatedResource.getResourceCode())) {
                relatedResourceResolver2 = new RelatedResourceResolver(relatedResource, themeFilePath);
            }
        }
        String wallpaperContentPath = set.contains("wallpaper") ? RelatedResourceResolver.getWallpaperContentPath(relatedResourceResolver, "wallpaper") : null;
        this.f78979o = set.contains("lockscreen") ? RelatedResourceResolver.getWallpaperContentPath(relatedResourceResolver2, "lockscreen") : "";
        boolean zEquals = com.android.thememanager.basemodule.utils.wallpaper.c0.f62414a.equals(wallpaperContentPath);
        boolean zEquals2 = com.android.thememanager.basemodule.utils.wallpaper.c0.f62414a.equals(this.f78979o);
        if (com.android.thememanager.basemodule.utils.wallpaper.v.w().p() && zEquals && zEquals2) {
            com.android.thememanager.basemodule.utils.wallpaper.c0.U(contextA, com.miui.miwallpaper.q.U);
        } else {
            if (!TextUtils.isEmpty(wallpaperContentPath)) {
                if (zEquals) {
                    com.android.thememanager.basemodule.utils.wallpaper.c0.U(contextA, 1);
                } else {
                    WallpaperApplyInfos wallpaperApplyInfos = new WallpaperApplyInfos(1, true, i10);
                    wallpaperApplyInfos.setMaml(this.f78980p);
                    com.android.thememanager.basemodule.utils.wallpaper.c0.o(contextA, wallpaperContentPath, null, null, false, false, ApplyThemeInfo.THEME_USING_TYPE_PROVISION.equals(this.f78975k), wallpaperApplyInfos);
                    if (com.android.thememanager.basemodule.utils.device.a.A()) {
                        WallpaperApplyInfos wallpaperApplyInfos2 = new WallpaperApplyInfos(4);
                        wallpaperApplyInfos2.setClearWallpaper(false);
                        wallpaperApplyInfos2.setMaml(this.f78980p);
                        com.android.thememanager.basemodule.utils.wallpaper.c0.o(contextA, wallpaperContentPath, null, null, true, false, ApplyThemeInfo.THEME_USING_TYPE_PROVISION.equals(this.f78975k), wallpaperApplyInfos2);
                    }
                }
            }
            if (!TextUtils.isEmpty(this.f78979o)) {
                if (zEquals2) {
                    com.android.thememanager.basemodule.utils.wallpaper.c0.U(contextA, 2);
                    if (com.android.thememanager.basemodule.utils.wallpaper.c0.f62414a.equals(this.f78979o)) {
                        String strZ = com.android.thememanager.basemodule.utils.wallpaper.c0.z();
                        if (!TextUtils.isEmpty(strZ)) {
                            com.android.thememanager.basemodule.utils.wallpaper.c0.k(contextA, strZ, ApplyThemeInfo.THEME_USING_TYPE_PROVISION.equals(this.f78975k), true, this.f78981q);
                        }
                    }
                } else {
                    com.android.thememanager.basemodule.utils.wallpaper.c0.k(contextA, this.f78979o, ApplyThemeInfo.THEME_USING_TYPE_PROVISION.equals(this.f78975k), true, this.f78981q);
                }
            }
        }
        MethodRecorder.o(17878);
    }

    private void e(Set<String> set) {
        MethodRecorder.i(17884);
        if (set.contains("fonts")) {
            j("/system/fonts");
            StringBuilder sb2 = new StringBuilder();
            String str = com.android.thememanager.basemodule.resource.constants.d.Nv;
            sb2.append(str);
            sb2.append("fonts");
            String string = sb2.toString();
            String str2 = str + ThemeResourceConstants.qy;
            File file = new File(str2);
            String str3 = str + ThemeResourceConstants.ty;
            File file2 = new File(str3);
            if (file.exists() && file2.exists()) {
                i(str2, string);
                k(str3, string);
            } else if (file.exists()) {
                i(str2, string);
            } else if (file2.exists()) {
                i(str3, string);
            }
            j(string);
        }
        StringBuilder sb3 = new StringBuilder();
        String str4 = com.android.thememanager.basemodule.resource.constants.d.Nv;
        sb3.append(str4);
        sb3.append(y1.f62653f);
        new File(sb3.toString()).renameTo(new File(str4 + "com.miui.home"));
        MethodRecorder.o(17884);
    }

    private void f(String str) {
        MethodRecorder.i(17871);
        if (!com.android.thememanager.basemodule.utils.j0.D()) {
            MethodRecorder.o(17871);
            return;
        }
        if (TextUtils.isEmpty(str)) {
            Log.d(f78962r, "copyLockWallpaperToPublic , lockWallpaperPath is empty");
            MethodRecorder.o(17871);
            return;
        }
        boolean z10 = false;
        if (com.android.thememanager.basemodule.utils.wallpaper.v.w().p() && com.android.thememanager.basemodule.utils.wallpaper.x.i() && this.f78971g.contains("lockstyle")) {
            try {
                InputStream inputStreamNewInputStream = Files.newInputStream(Paths.get(ThemeResourceConstants.Ny, new String[0]), new OpenOption[0]);
                z10 = inputStreamNewInputStream != null;
                if (inputStreamNewInputStream != null) {
                    inputStreamNewInputStream.close();
                }
            } catch (IOException e10) {
                Log.e(f78962r, "copyLockWallpaperToPublic:" + e10);
            }
        }
        if (!z10) {
            Log.d(f78962r, "copyLockWallpaperToPublic");
            if (com.android.thememanager.basemodule.utils.wallpaper.c0.f62414a.equals(str)) {
                str = com.android.thememanager.basemodule.utils.wallpaper.c0.z();
            }
            s3.i.m(str, com.android.thememanager.basemodule.resource.constants.b.U, 511);
        }
        MethodRecorder.o(17871);
    }

    private void g(Resource resource, ResourceContext resourceContext, Set<String> set) throws Throwable {
        int i10;
        boolean z10;
        float f10;
        String str;
        RelatedResourceResolver relatedResourceResolver;
        Resource resourceI;
        ResourceContext resourceContext2 = resourceContext;
        Set<String> set2 = set;
        int i11 = 17879;
        MethodRecorder.i(17879);
        try {
            boolean zX = x();
            HashSet<String> hashSet = new HashSet();
            List<RelatedResource> subResources = resource.getSubResources();
            b(subResources, set2, resourceContext2);
            c(subResources, this.f78966b.getThemeFilePath(), set2, resource.getWallpaperStyle());
            String rightsPath = new ResourceResolver(resource, resourceContext2).getRightsPath();
            hashSet.add(rightsPath);
            int localPlatform = resource.getLocalPlatform();
            Iterator<RelatedResource> it = subResources.iterator();
            while (true) {
                if (!it.hasNext()) {
                    i10 = i11;
                    z10 = false;
                    break;
                }
                i10 = i11;
                try {
                    if (ThemeResourceConstants.qz.equals(it.next().getResourceCode())) {
                        z10 = true;
                        break;
                    }
                    i11 = i10;
                } catch (Exception e10) {
                    e = e10;
                    e.printStackTrace();
                }
            }
            if (set2.contains(ThemeResourceConstants.VA)) {
                s3.i.C(b2.f61728d);
            }
            float f11 = -1.0f;
            for (RelatedResource relatedResource : subResources) {
                String resourceCode = relatedResource.getResourceCode();
                float f12 = f11;
                z10 = z10;
                this.f78968d = G(this.f78968d, 1);
                if (!"framework".equals(resourceCode) || localPlatform >= ThemeResourceConstants.qA) {
                    if (f12 != -1.0f || (resourceI = ResourceHelper.i(relatedResource, this.f78966b.getThemeFilePath())) == null) {
                        f10 = f12;
                    } else {
                        float miuiAdapterVersion = resourceI.getMiuiAdapterVersion();
                        Log.i(f78962r, "themeVersion = " + miuiAdapterVersion);
                        f10 = miuiAdapterVersion;
                    }
                    String strS = com.android.thememanager.basemodule.utils.e.s(resourceCode);
                    if (strS == null || !set2.contains(strS) || y1.B(resourceCode) || !y1.z(localPlatform, strS) || w(resourceCode)) {
                        Log.d(f78962r, "code " + resourceCode + " is not apply");
                    } else {
                        RelatedResourceResolver relatedResourceResolver2 = new RelatedResourceResolver(relatedResource, resourceContext2);
                        String strK = ResourceHelper.K(relatedResourceResolver2.getContentPath());
                        if (com.android.thememanager.basemodule.resource.constants.c.Hv.equals(strK) || t(resourceCode, relatedResourceResolver2.getContentPath())) {
                            str = strK;
                            relatedResourceResolver = relatedResourceResolver2;
                        } else {
                            str = strK;
                            if (s3.i.h(relatedResourceResolver2.getContentPath(), com.android.thememanager.basemodule.utils.e.k(resourceCode))) {
                                relatedResourceResolver = relatedResourceResolver2;
                                Log.i(f78962r, "resCode " + resourceCode + " copy success");
                            } else {
                                try {
                                    Log.i(f78962r, "resCode " + resourceCode + " copy error");
                                    String contentPath = relatedResourceResolver2.getContentPath();
                                    String strK2 = com.android.thememanager.basemodule.utils.e.k(resourceCode);
                                    File file = new File(contentPath);
                                    File file2 = new File(strK2);
                                    StructStat structStatStat = Os.stat(contentPath);
                                    StringBuilder sb2 = new StringBuilder();
                                    sb2.append("sourceFile:");
                                    sb2.append(file.getAbsolutePath());
                                    sb2.append(" size:");
                                    relatedResourceResolver = relatedResourceResolver2;
                                    try {
                                        sb2.append(file.length());
                                        sb2.append(" os_state:");
                                        sb2.append(structStatStat.st_uid);
                                        sb2.append("_");
                                        sb2.append(structStatStat.st_gid);
                                        Log.i(f78962r, sb2.toString());
                                        StructStat structStatStat2 = Os.stat(strK2);
                                        Log.i(f78962r, "desFile:" + file2.getAbsolutePath() + " size:" + file2.length() + " os_state:" + structStatStat2.st_uid + "_" + structStatStat2.st_gid);
                                    } catch (Exception e11) {
                                        e = e11;
                                        e.printStackTrace();
                                    }
                                } catch (Exception e12) {
                                    e = e12;
                                    relatedResourceResolver = relatedResourceResolver2;
                                }
                            }
                            if (ThemeResourceConstants.eB.equals(resourceCode) && !z10) {
                                s3.i.h(relatedResourceResolver.getContentPath(), ThemeResourceConstants.wz);
                            }
                        }
                        String rightsPath2 = relatedResourceResolver.getRightsPath();
                        if (new File(rightsPath2).exists()) {
                            hashSet.add(rightsPath2);
                        } else {
                            rightsPath2 = rightsPath;
                        }
                        String strU = null;
                        String metaPath = y1.H(resourceCode) ? null : relatedResourceResolver.getMetaPath();
                        if ("fonts".equals(resourceCode) || "miwallpaper".equals(resourceCode)) {
                            ResourceContext resourceContextE = com.android.thememanager.basemodule.controller.a.e().g().e(resourceCode);
                            Resource resourceI2 = ResourceHelper.i(relatedResource, this.f78966b.getThemeFilePath());
                            if (resourceI2 != null) {
                                strU = y1.u(resourceContextE, resourceI2);
                            }
                        }
                        b2.z(resourceCode, metaPath, ThemeResourceConstants.hz + (zX ? q(miuix.core.util.e.f(rightsPath2)) : miuix.core.util.e.f(rightsPath2)), resource.getLocalId(), resource.getTitle(), str, strU);
                    }
                    resourceContext2 = resourceContext;
                    set2 = set;
                    f11 = f10;
                    zX = zX;
                    rightsPath = rightsPath;
                } else {
                    f11 = f12;
                }
            }
            boolean z11 = zX;
            boolean zH = true;
            for (String str2 : hashSet) {
                String strQ = z11 ? q(miuix.core.util.e.f(str2)) : miuix.core.util.e.f(str2);
                StringBuilder sb3 = new StringBuilder();
                String str3 = ThemeResourceConstants.hz;
                sb3.append(str3);
                sb3.append(strQ);
                zH &= s3.i.h(str2, sb3.toString());
                this.f78978n = str3 + strQ;
            }
            if (!zH) {
                F();
            }
        } catch (Exception e13) {
            e = e13;
            i10 = i11;
        }
        MethodRecorder.o(i10);
    }

    private void h(Resource resource, Set<String> set) {
        MethodRecorder.i(17873);
        boolean zEquals = "theme".equals(this.f78966b.getResourceCode());
        String metaPath = new ResourceResolver(resource, this.f78966b).getMetaPath();
        boolean z10 = (resource.getLocalPlatform() > 5 || ResourceHelper.n0(metaPath) || ResourceHelper.f0(metaPath)) ? false : true;
        ArrayList arrayList = new ArrayList();
        if (zEquals) {
            Collections.addAll(arrayList, ThemeResourceConstants.lB);
        } else {
            arrayList.addAll(set);
        }
        ArrayList arrayList2 = new ArrayList();
        ArrayList arrayList3 = new ArrayList();
        for (String str : ThemeResourceConstants.lB) {
            if (arrayList.contains(str)) {
                if ("framework".equals(str)) {
                    StringBuilder sb2 = new StringBuilder();
                    String str2 = com.android.thememanager.basemodule.resource.constants.d.Nv;
                    sb2.append(str2);
                    sb2.append(ThemeResourceConstants.cy);
                    arrayList2.add(sb2.toString());
                    StringBuilder sb3 = new StringBuilder();
                    String str3 = com.android.thememanager.basemodule.resource.constants.d.Pv;
                    sb3.append(str3);
                    sb3.append(e3.f.f153095d);
                    arrayList3.add(sb3.toString());
                    arrayList2.add(str2 + "framework-miui-res");
                    arrayList3.add(str3 + miuix.core.util.t.f183949b);
                } else {
                    String strK = com.android.thememanager.basemodule.utils.e.k(str);
                    String str4 = com.android.thememanager.basemodule.resource.constants.d.Pv + new File(strK).getName();
                    arrayList2.add(strK);
                    arrayList3.add(str4);
                }
            }
        }
        for (int i10 = 0; i10 < arrayList2.size(); i10++) {
            if (z10 && (zEquals || new File((String) arrayList2.get(i10)).exists())) {
                s3.i.B((String) arrayList3.get(i10));
            } else {
                s3.i.C((String) arrayList3.get(i10));
            }
        }
        MethodRecorder.o(17873);
    }

    private void i(String str, String str2) {
        MethodRecorder.i(17885);
        String[] strArr = {"Miui-Regular.ttf", "Miui-Bold.ttf", "MiuiEx-Regular.ttf", "MiuiEx-Bold.ttf", "MiuiEx-Light.ttf", "Roboto-Italic.ttf", "Roboto-Bold.ttf", "Roboto-BoldItalic.ttf", "Roboto-Light.ttf", "Roboto-LightItalic.ttf", "Roboto-Medium.ttf", "Roboto-MediumItalic.ttf", "Roboto-Black.ttf", "Roboto-BlackItalic.ttf", "Roboto-Thin.ttf", "Roboto-ThinItalic.ttf"};
        for (int i10 = 0; i10 < 16; i10++) {
            z(str, str2 + RemoteSettings.f109300i + strArr[i10]);
        }
        MethodRecorder.o(17885);
    }

    private void j(String str) {
        File[] fileArrListFiles;
        MethodRecorder.i(17887);
        if (str != null) {
            if (miuix.os.f.c("ro.skia.use_data_fonts", 0) == 1 && (fileArrListFiles = new File(str).listFiles()) != null) {
                for (File file : fileArrListFiles) {
                    s3.i.C("/data/fonts/" + file.getName());
                    z(file.getAbsolutePath(), "/data/fonts/" + file.getName());
                }
            }
        }
        MethodRecorder.o(17887);
    }

    private void k(String str, String str2) {
        MethodRecorder.i(17886);
        z(str, str2 + "/DroidSansFallback-zh.ttf");
        MethodRecorder.o(17886);
    }

    private static void l(List<String> list) {
        MethodRecorder.i(17876);
        Iterator<String> it = list.iterator();
        while (it.hasNext()) {
            s3.i.C(it.next());
        }
        MethodRecorder.o(17876);
    }

    private boolean m(Context context) {
        MethodRecorder.i(17866);
        boolean z10 = Settings.Secure.getInt(context.getContentResolver(), "device_provisioned", 0) != 0;
        MethodRecorder.o(17866);
        return z10;
    }

    private static List<String> o() {
        MethodRecorder.i(17875);
        ArrayList arrayList = new ArrayList();
        for (String str : new File(com.android.thememanager.basemodule.resource.constants.d.Nv).list()) {
            if (!str.startsWith("preview") && !str.startsWith("description.xml") && !str.startsWith("fonts") && !str.startsWith(com.android.thememanager.basemodule.utils.wallpaper.x.f62560h) && !str.startsWith(ThemeResourceConstants.iz) && !str.startsWith(b2.f61725a)) {
                String[] strArr = ThemeResourceConstants.Hz;
                int length = strArr.length;
                int i10 = 0;
                while (true) {
                    if (i10 >= length) {
                        arrayList.add(com.android.thememanager.basemodule.resource.constants.d.Nv + str);
                        break;
                    }
                    if (str.startsWith(com.android.thememanager.basemodule.utils.e.f(strArr[i10]))) {
                        break;
                    }
                    i10++;
                }
            }
        }
        MethodRecorder.o(17875);
        return arrayList;
    }

    private InputStream p(List<String> list) throws IOException {
        boolean z10;
        MethodRecorder.i(17892);
        if (list == null) {
            z10 = false;
            break;
        }
        Iterator<String> it = list.iterator();
        while (true) {
            if (!it.hasNext()) {
                z10 = false;
                break;
            }
            String next = it.next();
            if (next.contains("miwallpaper")) {
                s3.i.h(next, com.android.thememanager.basemodule.resource.constants.e.Fw);
                z10 = true;
                break;
            }
        }
        if (com.android.thememanager.basemodule.utils.wallpaper.x.k()) {
            if (z10) {
                InputStream inputStreamNewInputStream = Files.newInputStream(Paths.get(com.android.thememanager.basemodule.resource.constants.e.Fw, new String[0]), new OpenOption[0]);
                MethodRecorder.o(17892);
                return inputStreamNewInputStream;
            }
            String str = ThemeResourceConstants.My;
            Path path = Paths.get(str, new String[0]);
            if (Files.exists(path, new LinkOption[0])) {
                InputStream inputStreamNewInputStream2 = Files.newInputStream(path, new OpenOption[0]);
                MethodRecorder.o(17892);
                return inputStreamNewInputStream2;
            }
            Log.i(f78962r, "getDeskMamlPreview: no wallpaper file found at " + str);
            Bitmap bitmapB = com.android.thememanager.basemodule.utils.wallpaper.v.w().B(1);
            if (bitmapB != null) {
                ByteArrayOutputStream byteArrayOutputStream = new ByteArrayOutputStream();
                bitmapB.compress(Bitmap.CompressFormat.PNG, 100, byteArrayOutputStream);
                ByteArrayInputStream byteArrayInputStream = new ByteArrayInputStream(byteArrayOutputStream.toByteArray());
                MethodRecorder.o(17892);
                return byteArrayInputStream;
            }
        }
        MethodRecorder.o(17892);
        return null;
    }

    private static List<String> r(Set<String> set) {
        boolean z10;
        MethodRecorder.i(17874);
        ArrayList arrayList = new ArrayList();
        String[] strArr = ThemeResourceConstants.Hz;
        int length = strArr.length;
        int i10 = 0;
        while (true) {
            if (i10 >= length) {
                z10 = true;
                break;
            }
            String str = strArr[i10];
            if (!com.android.thememanager.basemodule.resource.a.d(str) && !set.contains(str)) {
                z10 = false;
                break;
            }
            i10++;
        }
        if (!set.contains(com.android.thememanager.basemodule.analysis.a.Pq)) {
            z10 = false;
        }
        if (z10) {
            for (String str2 : new File(com.android.thememanager.basemodule.resource.constants.d.Nv).list()) {
                if (!str2.contains(b2.f61725a)) {
                    arrayList.add(com.android.thememanager.basemodule.resource.constants.d.Nv + str2);
                }
            }
        } else {
            for (String str3 : set) {
                if (!com.android.thememanager.basemodule.analysis.a.Pq.equals(str3)) {
                    arrayList.add(com.android.thememanager.basemodule.utils.e.k(str3));
                    arrayList.add(String.format("%s%s/%s", com.android.thememanager.basemodule.resource.constants.d.Nv, "preview", com.android.thememanager.basemodule.utils.e.i(str3)));
                }
            }
            if (set.contains("launcher")) {
                arrayList.add(com.android.thememanager.basemodule.resource.constants.d.Nv + y1.f62653f);
            }
            if (set.contains(ThemeResourceConstants.XA)) {
                arrayList.add(com.android.thememanager.basemodule.resource.constants.d.Nv + "miui.systemui.plugin");
            }
            if (set.contains("lockstyle")) {
                arrayList.add(y1.q());
            }
            if (set.contains("fonts")) {
                arrayList.add(com.android.thememanager.basemodule.resource.constants.d.Nv + "fonts");
            }
            if (set.contains("framework")) {
                arrayList.add(com.android.thememanager.basemodule.resource.constants.d.Nv + "description.xml");
            }
            if (set.contains(com.android.thememanager.basemodule.analysis.a.Pq)) {
                arrayList.addAll(o());
            }
        }
        MethodRecorder.o(17874);
        return arrayList;
    }

    private int s(InputStream inputStream, Set<String> set) {
        MethodRecorder.i(17872);
        int i10 = (inputStream != null || TextUtils.isEmpty(this.f78979o)) ? 0 : 2;
        if (set.contains("miwallpaper") || set.contains("wallpaper")) {
            i10 |= 1;
        }
        MethodRecorder.o(17872);
        return i10;
    }

    private boolean t(String str, String str2) {
        MethodRecorder.i(17883);
        if (!ResourceHelper.h0(str2)) {
            MethodRecorder.o(17883);
            return false;
        }
        boolean z10 = "bootanimation".equals(str) || "bootaudio".equals(str);
        MethodRecorder.o(17883);
        return z10;
    }

    private boolean v() {
        MethodRecorder.i(17865);
        boolean zEquals = TextUtils.equals("fonts", this.f78966b.getResourceCode());
        MethodRecorder.o(17865);
        return zEquals;
    }

    private static boolean w(String str) {
        MethodRecorder.i(17889);
        for (String str2 : ThemeResourceConstants.Yx) {
            if (str2.equals(str)) {
                MethodRecorder.o(17889);
                return true;
            }
        }
        boolean z10 = "wallpaper".equals(str) || "lockscreen".equals(str);
        MethodRecorder.o(17889);
        return z10;
    }

    private boolean x() {
        MethodRecorder.i(17881);
        String resourceCode = this.f78966b.getResourceCode();
        boolean z10 = ("theme".equals(resourceCode) || "fonts".equals(resourceCode)) ? false : true;
        MethodRecorder.o(17881);
        return z10;
    }

    private boolean y() {
        MethodRecorder.i(17864);
        boolean zEquals = TextUtils.equals("theme", this.f78966b.getResourceCode());
        MethodRecorder.o(17864);
        return zEquals;
    }

    private void z(String str, String str2) {
        MethodRecorder.i(17888);
        try {
            s3.i.x(str, str2);
        } catch (Exception e10) {
            Log.e(f78962r, "createSymbolicLink error oldPath = " + str + " newPath = " + str2 + "  " + e10);
        }
        MethodRecorder.o(17888);
    }

    /* JADX INFO: Access modifiers changed from: protected */
    /* JADX WARN: Code duplicated, block: B:36:0x00a4  */
    @Override // android.os.AsyncTask
    /* JADX INFO: renamed from: C, reason: merged with bridge method [inline-methods] */
    public void onPostExecute(String str) {
        boolean zC;
        miuix.appcompat.app.d1 d1Var;
        MethodRecorder.i(17862);
        Context context = this.f78965a.get();
        boolean z10 = context instanceof Activity;
        if (z10 && q2.Q(q2.v(context)) && (d1Var = this.f78967c) != null) {
            try {
                d1Var.dismiss();
            } catch (Error | Exception e10) {
                k8.a.l(e10);
            }
        }
        androidx.lifecycle.k0<Boolean> k0Var = this.f78977m;
        if (k0Var != null) {
            k0Var.r(Boolean.TRUE);
        }
        n4.b.i(com.android.thememanager.basemodule.analysis.a.or, this.f78966b.getResourceCode(), this.f78970f, "complete", context instanceof BaseActivity ? ((BaseActivity) context).Q0() : null, this.f78976l);
        if (y()) {
            k8.a.h("AppliedAdHelper", "save theme applied state");
            com.android.thememanager.ad.a.d();
        }
        if (y()) {
            com.android.thememanager.basemodule.analysis.f.r(1005, null, com.android.thememanager.basemodule.analysis.g.A6, null);
            if (com.android.thememanager.ad.d.k(1005)) {
                zC = com.android.thememanager.ad.appliedad.d.c(context, "theme");
            } else {
                zC = false;
            }
        } else if (v()) {
            com.android.thememanager.basemodule.analysis.f.r(4004, null, com.android.thememanager.basemodule.analysis.g.A6, null);
            if (!com.android.thememanager.ad.d.k(4004) || this.f78972h.isSettingsFont) {
                zC = false;
            } else {
                zC = com.android.thememanager.ad.appliedad.d.c(context, "fonts");
            }
        } else {
            zC = false;
        }
        if (this.f78971g.contains(ThemeResourceConstants.vz)) {
            com.android.thememanager.basemodule.utils.wallpaper.a.s(this.f78965a.get(), this.f78970f, this.f78966b, this.f78975k, this.f78971g.contains("lockscreen"));
        }
        if (context != null && !zC) {
            y1.Q(context, true, str);
        }
        if ("theme".equals(this.f78966b.getResourceCode())) {
            y1.P();
        }
        Runnable runnable = this.f78974j;
        if (runnable != null) {
            runnable.run();
        }
        ThemeSchedulerService.g();
        ThemeSchedulerService.A();
        if (z10 && q2.Q(q2.v(context)) && ApplyThemeInfo.THEME_USING_TYPE_PROVISION.equals(this.f78975k)) {
            Activity activityV = q2.v(context);
            activityV.setResult(-1);
            activityV.finish();
        }
        if (this.f78971g.contains(ThemeResourceConstants.VA)) {
            com.android.thememanager.basemodule.utils.j0.T();
        }
        A(this.f78971g);
        if (c3.b(31) && d3.e.h().validateAfterApply) {
            new a1(this.f78970f, this.f78971g, this.f78978n).execute(new Void[0]);
        }
        MethodRecorder.o(17862);
    }

    /* JADX INFO: Access modifiers changed from: protected */
    @Override // android.os.AsyncTask
    /* JADX INFO: renamed from: D, reason: merged with bridge method [inline-methods] */
    public void onProgressUpdate(Integer... numArr) {
        MethodRecorder.i(17868);
        if (numArr == null) {
            MethodRecorder.o(17868);
            return;
        }
        int iIntValue = numArr[0].intValue();
        miuix.appcompat.app.d1 d1Var = this.f78967c;
        if (d1Var != null) {
            d1Var.M0(iIntValue);
        }
        MethodRecorder.o(17868);
    }

    public void E(Runnable runnable) {
        MethodRecorder.i(17858);
        this.f78974j = runnable;
        MethodRecorder.o(17858);
    }

    public void d(Context context) throws Throwable {
        MethodRecorder.i(17890);
        if (new File(com.android.thememanager.basemodule.utils.device.g.f61900p).exists()) {
            com.android.thememanager.basemodule.utils.wallpaper.c0.c(context);
        }
        MethodRecorder.o(17890);
    }

    /* JADX INFO: Access modifiers changed from: protected */
    @Override // android.os.AsyncTask
    /* JADX INFO: renamed from: n, reason: merged with bridge method [inline-methods] */
    public String doInBackground(Void... voidArr) throws Throwable {
        boolean z10;
        boolean zIsOpenLockScreenMagazine;
        MethodRecorder.i(17861);
        String resourceCode = this.f78966b.getResourceCode();
        try {
            if (!this.f78972h.getIgnoreCodeSet().contains("lockstyle") && LockscreenWallpaperHelper.usingFashionGallery()) {
                LockscreenWallpaperHelper.logApplyThemeDisableFashion();
            }
            zIsOpenLockScreenMagazine = this.f78970f.isSystemOrPreCutsRes() ? LockscreenWallpaperHelper.isOpenLockScreenMagazine() : false;
            try {
                Log.d(f78962r, "needOpenLockGallery = " + zIsOpenLockScreenMagazine + ", needOpenHomeGallery = false");
                Resource resourceR = ResourceHelper.R(this.f78970f, this.f78966b);
                if (resourceR != null) {
                    String productId = this.f78970f.getProductId();
                    String productId2 = resourceR.getProductId();
                    this.f78970f = resourceR;
                    if (TextUtils.isEmpty(productId2) && !TextUtils.isEmpty(productId)) {
                        this.f78970f.setProductId(productId);
                    }
                }
                boolean zY = com.android.thememanager.basemodule.utils.wallpaper.v.w().Y();
                a(this.f78970f, this.f78966b, this.f78971g);
                B(zY);
            } catch (Exception e10) {
                z10 = zIsOpenLockScreenMagazine;
                e = e10;
                com.android.thememanager.basemodule.utils.g.b(e);
                zIsOpenLockScreenMagazine = z10;
            }
        } catch (Exception e11) {
            e = e11;
            z10 = false;
        }
        long jCurrentTimeMillis = System.currentTimeMillis() - this.f78969e;
        if (jCurrentTimeMillis < 1000) {
            try {
                Thread.sleep(1000 - jCurrentTimeMillis);
            } catch (InterruptedException e12) {
                k8.a.s(f78962r, "sleep failed: " + e12);
            }
        }
        Context context = this.f78965a.get();
        if (context == null) {
            MethodRecorder.o(17861);
            return null;
        }
        com.android.thememanager.basemodule.utils.wallpaper.v.w().c0(false, zIsOpenLockScreenMagazine);
        if (ApplyThemeInfo.THEME_USING_TYPE_PROVISION.equals(this.f78975k)) {
            d(context);
        }
        MethodRecorder.o(17861);
        return resourceCode;
    }

    @Override // android.os.AsyncTask
    protected void onPreExecute() {
        MethodRecorder.i(17860);
        Context context = this.f78965a.get();
        boolean zIsEmpty = this.f78971g.isEmpty();
        if (context != null && this.f78972h.isShowProgress()) {
            miuix.appcompat.app.d1 d1Var = new miuix.appcompat.app.d1(context);
            this.f78967c = d1Var;
            d1Var.Q0(1);
            String string = context.getString(R.string.theme_changing_dialog_title);
            if (this.f78973i != null) {
                string = string + this.f78973i;
            }
            this.f78967c.d0(string);
            this.f78967c.setCancelable(false);
            try {
                this.f78967c.show();
                this.f78969e = System.currentTimeMillis();
            } catch (Exception unused) {
                zIsEmpty = true;
            }
            this.f78967c.O0("");
        }
        String strQ0 = context instanceof BaseActivity ? ((BaseActivity) context).Q0() : null;
        if (zIsEmpty) {
            if (context != null) {
                y1.Q(context, false, "");
            }
            cancel(false);
            n4.b.i(com.android.thememanager.basemodule.analysis.a.or, this.f78966b.getResourceCode(), this.f78970f, "fail", strQ0, this.f78976l);
            MethodRecorder.o(17860);
            return;
        }
        Iterator<String> it = this.f78971g.iterator();
        while (it.hasNext()) {
            b2.f(it.next());
        }
        Log.i(com.android.thememanager.basemodule.utils.c1.f61769n, "Applying theme BEGIN: " + this.f78970f.getTitle());
        n4.b.i(com.android.thememanager.basemodule.analysis.a.or, this.f78966b.getResourceCode(), this.f78970f, "start", strQ0, this.f78976l);
        MethodRecorder.o(17860);
    }

    public String q(String str) {
        MethodRecorder.i(17882);
        String str2 = this.f78966b.getResourceCode() + "_" + str;
        MethodRecorder.o(17882);
        return str2;
    }

    public boolean u(String str) {
        MethodRecorder.i(17859);
        boolean zContains = this.f78971g.contains(str);
        MethodRecorder.o(17859);
        return zContains;
    }
}
