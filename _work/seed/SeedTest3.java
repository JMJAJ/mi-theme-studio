import dalvik.system.DexClassLoader;

public class SeedTest3 {
  public static void main(String[] a) throws Exception {
    DexClassLoader cl = new DexClassLoader(a[0], a[1], null, ClassLoader.getSystemClassLoader());
    String[] names = {
      "com.android.thememanager.activity.ThemeTabActivity",
      "com.android.thememanager.mine.base.LocalResourceListFragment",
      "com.android.thememanager.basemodule.unzip.b",
      "com.android.thememanager.basemodule.unzip.c",
      "com.android.thememanager.basemodule.controller.r",
      "g3.f",
      "com.android.thememanager.basemodule.resource.model.Resource",
      "com.android.thememanager.basemodule.resource.model.ResourceLocalProperties",
      "com.android.thememanager.basemodule.model.ResourceContext",
      "com.android.thememanager.basemodule.resource.constants.ThemeResourceConstants",
      "com.android.thememanager.basemodule.utils.e"
    };
    for (String n : names) {
      try { Class<?> c = cl.loadClass(n); System.out.println("OK " + n); }
      catch (Throwable t) { System.out.println("FAIL " + n + " :: " + t.getClass().getSimpleName() + ": " + t.getMessage()); }
    }
  }
}
