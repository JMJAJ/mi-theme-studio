#!/system/bin/sh
# Re-run the staged AOD full-apply manifest after the framework resets the theme.
# Runs as the adb shell user; no root. Reboot stops it.
LOG=/data/local/tmp/mts_aod_keep.log
PARAM=/data/local/tmp/mts_aod_param.json

apply() {
  settings put secure maml "$(cat "$PARAM")"
  settings put secure aod_category_name maml
  input keyevent KEYCODE_WAKEUP
  sleep 1
  input keyevent KEYCODE_SLEEP
  sleep 20
  am force-stop com.android.systemui
  am force-stop com.miui.home
  am force-stop com.mi.android.globallauncher
  am start -a android.intent.action.MAIN -c android.intent.category.HOME
  sleep 5
  settings put system clock_changed_time_2x4 "$(date +%s%3N)"
  echo "$(date): AOD reapply" >> "$LOG"
}

apply
last=$(stat -c %Y /data/system/theme 2>/dev/null)

while true; do
  sleep 30
  now=$(stat -c %Y /data/system/theme 2>/dev/null)
  if [ "$now" != "$last" ]; then
    apply
    last=$(stat -c %Y /data/system/theme 2>/dev/null)
  fi
done
