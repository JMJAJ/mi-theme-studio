import dalvik.system.DexClassLoader;

public class SeedProbe {
  public static void main(String[] a) throws Exception {
    String dexPath = a[0];
    String cls = a[1];
    try {
      DexClassLoader cl = new DexClassLoader(dexPath, "/data/local/tmp/dexopt", null, ClassLoader.getSystemClassLoader());
      Class<?> c = cl.loadClass(cls);
      System.out.println("OK " + dexPath + " -> " + c);
    } catch (Throwable t) {
      System.out.println("FAIL " + dexPath + " :: " + t.getClass().getSimpleName() + ": " + t.getMessage());
    }
  }
}
