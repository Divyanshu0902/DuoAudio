@echo off
setlocal

REM ==============================================================================
REM DuoAudio - Build Script for Native Windows Audio Endpoint Helper (Phase 7.1A)
REM Produces: duoaudio_endpoint.exe
REM ==============================================================================

set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%.."
set "PROJECT_ROOT=%CD%"
popd

set "SOURCE_FILE=%PROJECT_ROOT%\src\native\duoaudio_endpoint.cpp"
set "OUTPUT_EXE=%PROJECT_ROOT%\duoaudio_endpoint.exe"

echo [BUILD] Building DuoAudio Native Audio Endpoint Helper...
echo [BUILD] Source : "%SOURCE_FILE%"
echo [BUILD] Output : "%OUTPUT_EXE%"

if not exist "%SOURCE_FILE%" (
    echo [BUILD ERROR] Source file not found: "%SOURCE_FILE%" >&2
    exit /b 1
)

REM 1. Prefer MSVC (cl.exe) if available
where.exe cl.exe >nul 2>&1
if %ERRORLEVEL% equ 0 goto :USE_MSVC

REM 2. Check for MinGW-w64 (g++.exe) in PATH
where.exe g++.exe >nul 2>&1
if %ERRORLEVEL% equ 0 (
    set "GXX_CMD=g++.exe"
    goto :USE_MINGW
)

REM 3. Check for MinGW-w64 in C:\MingW\bin\g++.exe
if exist "C:\MingW\bin\g++.exe" (
    set "GXX_CMD=C:\MingW\bin\g++.exe"
    goto :USE_MINGW
)

echo [BUILD ERROR] No suitable C++ compiler found (checked for cl.exe and g++.exe). >&2
echo [BUILD ERROR] Please install Visual Studio C++ Build Tools or MinGW-w64 (x86_64). >&2
exit /b 1

:USE_MSVC
echo [BUILD] Found MSVC compiler (cl.exe).
echo [BUILD] Compiling with MSVC (/O2 /MT /EHsc /std:c++17)...
cl.exe /nologo /O2 /MT /EHsc /std:c++17 /W4 "%SOURCE_FILE%" /Fe:"%OUTPUT_EXE%" ole32.lib propsys.lib oleaut32.lib uuid.lib
if %ERRORLEVEL% neq 0 (
    echo [BUILD ERROR] MSVC compilation failed with exit code %ERRORLEVEL%. >&2
    exit /b %ERRORLEVEL%
)
if exist "%PROJECT_ROOT%\duoaudio_endpoint.obj" del "%PROJECT_ROOT%\duoaudio_endpoint.obj"
goto :SUCCESS

:USE_MINGW
echo [BUILD] Found MinGW-w64 compiler (%GXX_CMD%).
echo [BUILD] Compiling with MinGW-w64 (-O2 -s -municode -static -static-libgcc -static-libstdc++)...
"%GXX_CMD%" -O2 -s -Wall -municode -static -static-libgcc -static-libstdc++ -std=c++17 "%SOURCE_FILE%" -o "%OUTPUT_EXE%" -lole32 -lpropsys -loleaut32 -luuid
if %ERRORLEVEL% neq 0 (
    echo [BUILD ERROR] MinGW compilation failed with exit code %ERRORLEVEL%. >&2
    exit /b %ERRORLEVEL%
)
goto :SUCCESS

:SUCCESS
echo [BUILD SUCCESS] Produced: "%OUTPUT_EXE%"
if not exist "%PROJECT_ROOT%\resources\bin" mkdir "%PROJECT_ROOT%\resources\bin"
copy /y "%OUTPUT_EXE%" "%PROJECT_ROOT%\resources\bin\duoaudio_endpoint.exe" >nul
echo [BUILD SUCCESS] Staged to resources: "%PROJECT_ROOT%\resources\bin\duoaudio_endpoint.exe"
exit /b 0

