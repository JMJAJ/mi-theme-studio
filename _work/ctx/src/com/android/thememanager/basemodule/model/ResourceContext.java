package com.android.thememanager.basemodule.model;

import java.io.*;
import java.util.*;

public class ResourceContext implements Serializable {
    private static final long serialVersionUID = 4L;

    private List<String> buildInImagePrefixes = new ArrayList<String>();
    private boolean categorySupported;
    private int displayType;
    private Map<String, Serializable> extraMeta = new HashMap<String, Serializable>();
    private int previewImageWidth;
    private boolean purchaseSupported;
    private int recommendImageWidth;
    private String resourceCode;
    private String resourceExtension;
    private int resourceFormat;
    private String resourceIdentity;
    private String resourceStamp;
    private String resourceTitle;
    private boolean selfDescribing;
    private int thumbnailImageWidth;
    private boolean thumbnailPngFormat;
    private boolean trialSupported;
    private boolean versionSupported;
    private String volumeType;

    public static void main(String[] args) throws Exception {
        ResourceContext c = new ResourceContext();
        c.resourceCode = "theme";
        c.resourceFormat = 1;
        c.resourceExtension = ".mtz";
        c.selfDescribing = false;
        c.versionSupported = true;
        c.categorySupported = true;
        c.resourceIdentity = "theme";
        c.resourceStamp = "BundleUnion";
        c.displayType = 1;
        FileOutputStream fos = new FileOutputStream(args[0]);
        ObjectOutputStream oos = new ObjectOutputStream(fos);
        oos.writeObject(c);
        oos.close();
        System.out.println("CTX_WROTE " + new File(args[0]).length());
    }
}
