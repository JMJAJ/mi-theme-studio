import javaobj
p = r"C:\Users\Jxint\Desktop\XiaomiEditor\_work\seed\res.mrm"
obj = javaobj.loads(open(p,'rb').read())
print("obj type", type(obj))
print("obj attrs", [a for a in dir(obj) if not a.startswith('__')][:40])
cd = obj.classdesc
print("cd type", type(cd))
print("cd attrs", [a for a in dir(cd) if not a.startswith('__')][:40])
for a in ['name','serialVersionUID','fields','fields_names','fields_types','flags']:
    try: print(a, '=', getattr(cd,a))
    except Exception as e: print(a, 'ERR', e)
try:
    print('dict', obj.__dict__)
except Exception as e: print('dict err', e)
