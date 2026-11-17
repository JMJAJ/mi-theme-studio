public class SeedTest {
  public static void main(String[] a) throws Exception {
    System.out.println("APPPROC_OK args=" + java.util.Arrays.toString(a));
    try { Class<?> c = Class.forName("com.android.thememanager.basemodule.resource.model.Resource"); System.out.println("RES=" + c); }
    catch (Throwable t) { System.out.println("RES_FAIL " + t); }
    try { Class<?> c = Class.forName("com.android.thememanager.basemodule.model.ResourceContext"); System.out.println("CTX=" + c); }
    catch (Throwable t) { System.out.println("CTX_FAIL " + t); }
  }
}
