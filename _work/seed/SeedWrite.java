import dalvik.system.DexClassLoader;
import java.io.*;

public class SeedWrite {
  public static void main(String[] a) throws Exception {
    DexClassLoader cl = new DexClassLoader(a[0], a[1], null, ClassLoader.getSystemClassLoader());
    Class<?> rc = cl.loadClass("com.android.thememanager.basemodule.resource.model.Resource");
    Object r = rc.getConstructor().newInstance();
    rc.getMethod("setDownloadPath", String.class).invoke(r, a[2]);
    try { rc.getMethod("setLocalTitle", String.class).invoke(r, "Girl with Cat"); } catch (Throwable t) { System.out.println("title-skip " + t); }
    ObjectOutputStream oos = new ObjectOutputStream(new FileOutputStream(a[3]));
    oos.writeObject(r);
    oos.close();
    System.out.println("WROTE " + new File(a[3]).length());
  }
}
