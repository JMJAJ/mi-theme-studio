import javaobj, io, sys
p = r"C:\Users\Jxint\Desktop\XiaomiEditor\_work\seed\res.mrm"
data = open(p,'rb').read()
try:
    obj = javaobj.loads(data)
except Exception as e:
    print("loads failed", e)
    obj = None
print(type(obj))
def walk(o, depth=0, seen=None):
    if seen is None: seen=set()
    pad='  '*depth
    try:
        cd = o.classdesc
        print(f"{pad}class={cd.name} suid={cd.serialVersionUID}")
        for f in cd.fields:
            name=f.name if hasattr(f,'name') else str(f)
            typ=getattr(f,'type',None) or getattr(f,'field_type',None)
            try: val=getattr(o,f.name)
            except Exception: val='<n/a>'
            print(f"{pad}  field {f.name} type={typ} value={val!r}")
    except Exception as e:
        print(pad, "not a java object:", type(o), str(o)[:120])
walk(obj)
