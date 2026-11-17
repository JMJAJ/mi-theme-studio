import dalvik.system.InMemoryDexClassLoader;
import java.io.*;
import java.nio.ByteBuffer;
import java.util.*;

public class SeedTest5 {
  static byte[] read(File f) throws Exception { FileInputStream in=new FileInputStream(f); ByteArrayOutputStream o=new ByteArrayOutputStream(); byte[] b=new byte[1<<20]; int n; while((n=in.read(b))>0)o.write(b,0,n); in.close(); return o.toByteArray(); }
  public static void main(String[] a) throws Exception {
    File dir=new File(a[0]); File[] fs=dir.listFiles(); Arrays.sort(fs); ArrayList<ByteBuffer> bufs=new ArrayList<>();
    for(File f:fs) if(f.getName().endsWith(".dex")) bufs.add(ByteBuffer.wrap(read(f)));
    InMemoryDexClassLoader cl=new InMemoryDexClassLoader(bufs.toArray(new ByteBuffer[0]), ClassLoader.getSystemClassLoader());
    String[] names={"e3.c","com.android.thememanager.basemodule.resource.constants.ThemeResourceConstants","com.android.thememanager.basemodule.model.ResourceContext","com.android.thememanager.basemodule.resource.model.Resource"};
    for(String n:names){
      try{Class<?> c=Class.forName(n,false,cl);System.out.println("NOINIT_OK "+n+" iface="+c.isInterface());}catch(Throwable t){System.out.println("NOINIT_FAIL "+n+" :: "+t.getClass().getSimpleName()+": "+t.getMessage());}
      try{Class<?> c=Class.forName(n,true,cl);System.out.println("INIT_OK "+n);}catch(Throwable t){System.out.println("INIT_FAIL "+n+" :: "+t.getClass().getSimpleName()+": "+t.getMessage());}
    }
  }
}
