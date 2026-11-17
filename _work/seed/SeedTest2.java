import dalvik.system.DexClassLoader;

public class SeedTest2 {
  public static void main(String[] a) throws Exception {
    System.out.println("DEXLOAD_START " + a[0]);
    DexClassLoader cl = new DexClassLoader(a[0], a[1], null, ClassLoader.getSystemClassLoader());
    String[] names = {
      "com.android.thememanager.basemodule.resource.model.Resource",
      "com.android.thememanager.basemodule.model.ResourceContext",
      "com.android.thememanager.basemodule.resource.constants.ThemeResourceConstants"
    };
    for (String n : names) {
      try { System.out.println("OK " + n + " -> " + cl.loadClass(n)); }
      catch (Throwable t) { System.out.println("FAIL " + n + " :: " + t); }
    }
  }
}
