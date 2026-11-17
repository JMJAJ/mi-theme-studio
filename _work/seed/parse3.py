import javaobj
p = r"C:\Users\Jxint\Desktop\XiaomiEditor\_work\seed\res.mrm"
obj = javaobj.loads(open(p,'rb').read())
def dump(o, pad=""):
    try:
        cd=o.classdesc
    except Exception:
        print(pad+"value:", repr(o)[:200]); return
    print(f"{pad}{cd.name} suid={cd.serialVersionUID}")
    for n,t in zip(cd.fields_names, cd.fields_types):
        try: v=getattr(o,n)
        except Exception as e: v=f"<{e}>"
        if hasattr(v,'classdesc'):
            print(f"{pad}  {n} ({t}) ->")
            dump(v, pad+"    ")
        else:
            print(f"{pad}  {n} ({t}) = {v!r}")
dump(obj)
