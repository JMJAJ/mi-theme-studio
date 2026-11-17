for j in /system_ext/framework/*.jar /system/framework/*.jar; do
  for d in $(unzip -Z1 "$j" 2>/dev/null | grep -E '^classes[0-9]*[.]dex$'); do
    if unzip -p "$j" "$d" 2>/dev/null | grep -aq 'ResourceBrowserConstants'; then
      echo "FOUND $j $d"
    fi
  done
done
echo DONE