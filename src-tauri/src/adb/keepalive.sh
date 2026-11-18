#!/system/bin/sh
PATH=/system/bin:/system/xbin
THEME=/sdcard/Android/data/com.android.thememanager/files/keep.mtz
LOG=/data/local/tmp/mts_keep.log

[ -f "$THEME" ] || exit 1

apply() {
  am start -n com.android.thememanager/com.android.thememanager.ApplyThemeForScreenshot \
    -e api_called_from ThemeEditor \
    -e theme_file_path "$THEME" >/dev/null 2>&1
  echo "$(date): reapply" >> "$LOG"
}

awake() {
  dumpsys power 2>/dev/null | grep -q 'mWakefulness=Awake'
}

# Apply once, then watch the theme directory. The 2-hour DRM check removes
# invalid components and changes this mtime; reapply within ~30 seconds.
apply
sleep 5
last=$(stat -c %Y /data/system/theme 2>/dev/null)

while true; do
  sleep 30
  now=$(stat -c %Y /data/system/theme 2>/dev/null)
  if [ "$now" != "$last" ] && awake; then
    apply
    sleep 5
    last=$(stat -c %Y /data/system/theme 2>/dev/null)
  fi
done
