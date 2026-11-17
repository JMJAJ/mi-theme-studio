import dalvik.system.InMemoryDexClassLoader;
import java.io.File;
import java.io.FileInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Arrays;

public class SeedTest4 {
  static byte[] read(File f) throws Exception {
    FileInputStream in = new FileInputStream(f);
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    byte[] buf = new byte[1 << 20];
    int n;
    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    in.close();
    return out.toByteArray();
  }
  public static void main(String[] a) throws Exception {
    File dir = new File(a[0]);
    File[] files = dir.listFiles();
    Arrays.sort(files);
    ArrayList<ByteBuffer> bufs = new ArrayList<>();
    for (File f : files) {
      if (f.getName().endsWith(".dex")) bufs.add(ByteBuffer.wrap(read(f)));
    }
    System.out.println("DEX_BUFFERS=" + bufs.size());
    InMemoryDexClassLoader cl = new InMemoryDexClassLoader(bufs.toArray(new ByteBuffer[0]), ClassLoader.getSystemClassLoader());
    String[] names = {
      "com.android.thememanager.activity.ThemeTabActivity",
      "com.android.thememanager.mine.base.LocalResourceListFragment",
      "com.android.thememanager.basemodule.unzip.b",
      "com.android.thememanager.basemodule.unzip.c",
      "com.android.thememanager.basemodule.controller.r",
      "com.android.thememanager.basemodule.model.ResourceContext",
      "com.android.thememanager.basemodule.resource.model.Resource",
      "com.android.thememanager.basemodule.resource.model.ResourceLocalProperties",
      "com.android.thememanager.basemodule.resource.constants.ThemeResourceConstants",
      "com.android.thememanager.basemodule.utils.e",
      "g3.f",
      "g3.g"
    };
    for (String n : names) {
      try { cl.loadClass(n); System.out.println("OK " + n); }
      catch (Throwable t) { System.out.println("FAIL " + n + " :: " + t.getClass().getSimpleName() + ": " + t.getMessage()); }
    }
  }
}
