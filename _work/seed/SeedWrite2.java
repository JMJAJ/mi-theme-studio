import dalvik.system.DexClassLoader;
import java.io.*;

public class SeedWrite2 {
  public static void main(String[] a) {
    try {
      System.out.println("STEP1 load");
      DexClassLoader cl = new DexClassLoader(a[0], a[1], null, ClassLoader.getSystemClassLoader());
      Class<?> rc = cl.loadClass("com.android.thememanager.basemodule.resource.model.Resource");
      System.out.println("STEP2 new " + rc);
      Object r = rc.getConstructor().newInstance();
      System.out.println("STEP3 set downloadPath");
      rc.getMethod("setDownloadPath", String.class).invoke(r, a[2]);
      System.out.println("STEP4 serialize");
      ObjectOutputStream oos = new ObjectOutputStream(new FileOutputStream(a[3]));
      oos.writeObject(r);
      oos.close();
      System.out.println("WROTE " + new File(a[3]).length());
    } catch (Throwable t) {
      System.out.println("ERR " + t);
      t.printStackTrace();
    }
  }
}
