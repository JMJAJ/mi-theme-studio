import android.os.Looper;
import dalvik.system.InMemoryDexClassLoader;
import java.io.*;
import java.nio.ByteBuffer;
import java.util.*;

public class SeedWrite4 {
  static byte[] read(File f) throws Exception { FileInputStream in=new FileInputStream(f); ByteArrayOutputStream o=new ByteArrayOutputStream(); byte[] b=new byte[1<<20]; int n; while((n=in.read(b))>0)o.write(b,0,n); in.close(); return o.toByteArray(); }
  public static void main(String[] a) {
    try {
      Looper.prepareMainLooper();
      System.out.println("LOOPER " + Looper.getMainLooper());
      File dir=new File(a[0]); File[] fs=dir.listFiles(); Arrays.sort(fs); ArrayList<ByteBuffer> bufs=new ArrayList<>();
      for(File f:fs) if(f.getName().endsWith(".dex")) bufs.add(ByteBuffer.wrap(read(f)));
      InMemoryDexClassLoader cl=new InMemoryDexClassLoader(bufs.toArray(new ByteBuffer[0]), ClassLoader.getSystemClassLoader());
      Class<?> rc=cl.loadClass("com.android.thememanager.basemodule.resource.model.Resource");
      Object r=rc.getConstructor().newInstance();
      System.out.println("NEW ok");
      rc.getMethod("setDownloadPath", String.class).invoke(r, a[2]);
      System.out.println("PATH ok");
      ObjectOutputStream oos=new ObjectOutputStream(new FileOutputStream(a[3]));
      oos.writeObject(r); oos.close();
      System.out.println("WROTE " + new File(a[3]).length());
    } catch(Throwable t){ System.out.println("ERR " + t); t.printStackTrace(); }
  }
}
