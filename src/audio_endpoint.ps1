<#
.SYNOPSIS
    DuoAudio - Windows Core Audio Endpoint Mute & Volume Controller
.DESCRIPTION
    Interfaces directly with Windows Core Audio COM APIs (IMMDeviceEnumerator,
    IMMDevice, IAudioEndpointVolume, IPropertyStore) using fully-typed P/Invoke
    to query, mute, and restore endpoint mute states without external dependencies.
    Outputs single-line JSON to stdout for reliable IPC with Node.js.
#>

param(
    [Parameter(Mandatory=$true, Position=0)]
    [ValidateSet("query-default", "mute-by-id", "unmute-by-id", "get-by-id")]
    [string]$Action,

    [Parameter(Mandatory=$false, Position=1)]
    [string]$DeviceId = ""
)

$ErrorActionPreference = "Stop"

$csharpCode = @'
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct PROPERTYKEY {
    public Guid fmtid;
    public uint pid;
}

[StructLayout(LayoutKind.Explicit)]
public struct PROPVARIANT {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr pwszVal;
}

[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStore {
    int GetCount(out uint cProps);
    int GetAt(uint iProp, out PROPERTYKEY pkey);
    int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
    int SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
    int Commit();
}

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr pNotify);
    int UnregisterControlChangeNotify(IntPtr pNotify);
    int GetChannelCount(out uint pnChannelCount);
    int SetMasterVolumeLevel(float fLevelDB, ref Guid pguidEventContext);
    int SetMasterVolumeLevelScalar(float fLevel, ref Guid pguidEventContext);
    int GetMasterVolumeLevel(out float pfLevelDB);
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int SetChannelVolumeLevel(uint nChannel, float fLevelDB, ref Guid pguidEventContext);
    int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, ref Guid pguidEventContext);
    int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
    int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid pguidEventContext);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
    int GetVolumeStepInfo(out uint pnStep, out uint pnStepCount);
    int VolumeStepUp(ref Guid pguidEventContext);
    int VolumeStepDown(ref Guid pguidEventContext);
    int QueryHardwareSupport(out uint pdwHardwareSupportMask);
    int GetVolumeRange(out float pflVolumeMindB, out float pflVolumeMaxdB, out float pflVolumeIncrementdB);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
    int Activate(ref Guid id, int clsCtx, IntPtr activationParams, out IAudioEndpointVolume aev);
    int OpenPropertyStore(int stgmAccess, out IPropertyStore properties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out uint pdwState);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, uint dwStateMask, out IntPtr ppDevices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
    int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId, out IMMDevice endpoint);
    int RegisterEndpointNotificationCallback(IntPtr pClient);
    int UnregisterEndpointNotificationCallback(IntPtr pClient);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumeratorComObject {}

public class AudioBridge {
    public static string QueryDefault() {
        var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
        IMMDevice dev = null;
        IPropertyStore store = null;
        IAudioEndpointVolume epv = null;
        try {
            int hr = enumerator.GetDefaultAudioEndpoint(0, 0, out dev);
            if (hr != 0) return "{\"success\":false,\"error\":\"GetDefaultAudioEndpoint failed\",\"hresult\":\"" + hr.ToString("X") + "\"}";

            string id;
            hr = dev.GetId(out id);
            if (hr != 0) return "{\"success\":false,\"error\":\"GetId failed\",\"hresult\":\"" + hr.ToString("X") + "\"}";

            string name = "Unknown Device";
            hr = dev.OpenPropertyStore(0, out store);
            if (hr == 0 && store != null) {
                var key = new PROPERTYKEY {
                    fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"),
                    pid = 14
                };
                PROPVARIANT val;
                if (store.GetValue(ref key, out val) == 0 && val.pwszVal != IntPtr.Zero) {
                    name = Marshal.PtrToStringUni(val.pwszVal);
                }
            }

            var epvGuid = typeof(IAudioEndpointVolume).GUID;
            hr = dev.Activate(ref epvGuid, 23, IntPtr.Zero, out epv);
            if (hr != 0) return "{\"success\":false,\"error\":\"Activate failed\",\"hresult\":\"" + hr.ToString("X") + "\"}";

            bool isMuted;
            hr = epv.GetMute(out isMuted);
            if (hr != 0) return "{\"success\":false,\"error\":\"GetMute failed\",\"hresult\":\"" + hr.ToString("X") + "\"}";

            float vol;
            hr = epv.GetMasterVolumeLevelScalar(out vol);
            if (hr != 0) vol = 0.0f;

            string safeName = name.Replace("\\", "\\\\").Replace("\"", "\\\"");
            return "{\"success\":true,\"id\":\"" + id + "\",\"name\":\"" + safeName + "\",\"isMuted\":" + (isMuted ? "true" : "false") + ",\"volume\":" + vol + "}";
        } catch (Exception ex) {
            return "{\"success\":false,\"error\":\"" + ex.Message.Replace("\"", "'") + "\"}";
        } finally {
            if (epv != null) Marshal.ReleaseComObject(epv);
            if (store != null) Marshal.ReleaseComObject(store);
            if (dev != null) Marshal.ReleaseComObject(dev);
            if (enumerator != null) Marshal.ReleaseComObject(enumerator);
        }
    }

    public static string SetMuteById(string id, bool mute) {
        if (string.IsNullOrEmpty(id)) {
            return "{\"success\":false,\"error\":\"No endpoint ID provided\"}";
        }
        var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
        IMMDevice dev = null;
        IAudioEndpointVolume epv = null;
        try {
            int hr = enumerator.GetDevice(id, out dev);
            if (hr != 0) return "{\"success\":false,\"error\":\"GetDevice failed (device disconnected or invalid)\",\"hresult\":\"" + hr.ToString("X") + "\"}";

            var epvGuid = typeof(IAudioEndpointVolume).GUID;
            hr = dev.Activate(ref epvGuid, 23, IntPtr.Zero, out epv);
            if (hr != 0) return "{\"success\":false,\"error\":\"Activate failed\",\"hresult\":\"" + hr.ToString("X") + "\"}";

            bool oldMute;
            hr = epv.GetMute(out oldMute);
            if (hr != 0) return "{\"success\":false,\"error\":\"GetMute failed\",\"hresult\":\"" + hr.ToString("X") + "\"}";

            Guid ctx = Guid.Empty;
            hr = epv.SetMute(mute, ref ctx);
            if (hr != 0) return "{\"success\":false,\"error\":\"SetMute failed\",\"hresult\":\"" + hr.ToString("X") + "\"}";

            bool newMute;
            hr = epv.GetMute(out newMute);
            if (hr != 0) return "{\"success\":false,\"error\":\"GetMute verification failed\",\"hresult\":\"" + hr.ToString("X") + "\"}";

            return "{\"success\":true,\"id\":\"" + id + "\",\"oldMute\":" + (oldMute ? "true" : "false") + ",\"newMute\":" + (newMute ? "true" : "false") + "}";
        } catch (Exception ex) {
            return "{\"success\":false,\"error\":\"" + ex.Message.Replace("\"", "'") + "\"}";
        } finally {
            if (epv != null) Marshal.ReleaseComObject(epv);
            if (dev != null) Marshal.ReleaseComObject(dev);
            if (enumerator != null) Marshal.ReleaseComObject(enumerator);
        }
    }

    public static string GetMuteById(string id) {
        if (string.IsNullOrEmpty(id)) {
            return "{\"success\":false,\"error\":\"No endpoint ID provided\"}";
        }
        var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
        IMMDevice dev = null;
        IAudioEndpointVolume epv = null;
        try {
            int hr = enumerator.GetDevice(id, out dev);
            if (hr != 0) return "{\"success\":false,\"error\":\"GetDevice failed (device disconnected or invalid)\",\"hresult\":\"" + hr.ToString("X") + "\"}";

            var epvGuid = typeof(IAudioEndpointVolume).GUID;
            hr = dev.Activate(ref epvGuid, 23, IntPtr.Zero, out epv);
            if (hr != 0) return "{\"success\":false,\"error\":\"Activate failed\",\"hresult\":\"" + hr.ToString("X") + "\"}";

            bool isMuted;
            hr = epv.GetMute(out isMuted);
            if (hr != 0) return "{\"success\":false,\"error\":\"GetMute failed\",\"hresult\":\"" + hr.ToString("X") + "\"}";

            return "{\"success\":true,\"id\":\"" + id + "\",\"isMuted\":" + (isMuted ? "true" : "false") + "}";
        } catch (Exception ex) {
            return "{\"success\":false,\"error\":\"" + ex.Message.Replace("\"", "'") + "\"}";
        } finally {
            if (epv != null) Marshal.ReleaseComObject(epv);
            if (dev != null) Marshal.ReleaseComObject(dev);
            if (enumerator != null) Marshal.ReleaseComObject(enumerator);
        }
    }
}
'@

try {
    if (-not ([System.Management.Automation.PSTypeName]'AudioBridge').Type) {
        Add-Type -TypeDefinition $csharpCode
    }

    switch ($Action) {
        "query-default" {
            [AudioBridge]::QueryDefault()
            break
        }
        "mute-by-id" {
            [AudioBridge]::SetMuteById($DeviceId, $true)
            break
        }
        "unmute-by-id" {
            [AudioBridge]::SetMuteById($DeviceId, $false)
            break
        }
        "get-by-id" {
            [AudioBridge]::GetMuteById($DeviceId)
            break
        }
        default {
            '{"success":false,"error":"Invalid action specified"}'
        }
    }
} catch {
    $err = $_.Exception.Message.Replace('"', "'")
    Write-Output "{""success"":false,""error"":""PowerShell script error: $err""}"
}
