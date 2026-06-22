@echo off
echo Listing or creating app %*
rem simulate longer output
for /L %%i in (1,1,3) do (
  echo line %%i
  ping -n 2 127.0.0.1 >nul
)
exit /b 0
