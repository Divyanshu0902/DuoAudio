/**
 * DuoAudio - Native Windows Audio Endpoint Mute & Volume Controller
 * Phase 7.1A: Standalone C++ Windows Core Audio COM Helper
 *
 * Direct replacement for audio_endpoint.ps1 using Windows Core Audio APIs:
 * - IMMDeviceEnumerator
 * - IMMDevice
 * - IAudioEndpointVolume
 * - IPropertyStore
 * - IPolicyConfig (Core Audio private interface for default endpoint switching)
 *
 * Implements the CLI contract:
 * - query-default
 * - mute-by-id <endpointId>
 * - unmute-by-id <endpointId>
 * - get-by-id <endpointId>
 * - set-default-by-id <endpointId>
 * - list-endpoints
 *
 * Standardized Output Contract:
 * - stdout: strictly valid single-line JSON
 * - stderr: human-readable diagnostic messages
 * - exit code: 0 on success, non-zero on error
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <initguid.h>
#include <mmdeviceapi.h>
#include <endpointvolume.h>
#include <functiondiscoverykeys_devpkey.h>
#include <propsys.h>

#include <iostream>
#include <string>
#include <vector>
#include <sstream>
#include <iomanip>

// Windows Core Audio PolicyConfig interface definition for default render endpoint switching
// Supported on Windows Vista, 7, 8, 10, and 11
const GUID CLSID_CPolicyConfigClient = { 0x870af99c, 0x171d, 0x4f9e, { 0xaf, 0x0d, 0xe6, 0x3d, 0xf4, 0x0c, 0x2b, 0xc9 } };
const GUID IID_IPolicyConfig = { 0xf8679f50, 0x850a, 0x41cf, { 0x9c, 0x72, 0x43, 0x0f, 0x29, 0x02, 0x90, 0xc8 } };

interface IPolicyConfig : public IUnknown {
public:
    virtual HRESULT STDMETHODCALLTYPE GetMixFormat(PCWSTR, void**) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetDeviceFormat(PCWSTR, INT, void**) = 0;
    virtual HRESULT STDMETHODCALLTYPE ResetDeviceFormat(PCWSTR) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetDeviceFormat(PCWSTR, void*, void*) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetProcessingPeriod(PCWSTR, INT, PINT64, PINT64) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetProcessingPeriod(PCWSTR, PINT64) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetShareMode(PCWSTR, void**) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetShareMode(PCWSTR, void*) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetPropertyValue(PCWSTR, const PROPERTYKEY&, PROPVARIANT*) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetPropertyValue(PCWSTR, const PROPERTYKEY&, PROPVARIANT*) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetDefaultEndpoint(PCWSTR wszDeviceId, ERole eRole) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetEndpointVisibility(PCWSTR, INT) = 0;
};

// Minimal RAII wrapper for COM interfaces to guarantee clean deallocation
template <typename T>
class ComPtr {
    T* p = nullptr;
public:
    ComPtr() = default;
    explicit ComPtr(T* lp) : p(lp) {}
    ~ComPtr() {
        if (p) {
            p->Release();
            p = nullptr;
        }
    }
    T* operator->() const { return p; }
    T& operator*() const { return *p; }
    operator T*() const { return p; }
    T** operator&() {
        if (p) {
            p->Release();
            p = nullptr;
        }
        return &p;
    }
    T* get() const { return p; }
    void reset() {
        if (p) {
            p->Release();
            p = nullptr;
        }
    }
    ComPtr(const ComPtr&) = delete;
    ComPtr& operator=(const ComPtr&) = delete;
};

// RAII COM Initializer
class ScopedCoInit {
    HRESULT hr;
public:
    ScopedCoInit() {
        hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    }
    ~ScopedCoInit() {
        if (SUCCEEDED(hr)) {
            CoUninitialize();
        }
    }
    bool succeeded() const {
        return SUCCEEDED(hr) || hr == RPC_E_CHANGED_MODE;
    }
    HRESULT hresult() const { return hr; }
};

// Format HRESULT as 0xXXXXXXXX hex string
static std::string formatHresult(HRESULT hr) {
    std::ostringstream ss;
    ss << "0x" << std::uppercase << std::setfill('0') << std::setw(8) << std::hex
       << static_cast<unsigned long>(hr);
    return ss.str();
}

// Convert UTF-16 wide string to UTF-8 std::string
static std::string wstrToUtf8(const std::wstring& wstr) {
    if (wstr.empty()) return "";
    int sizeNeeded = WideCharToMultiByte(CP_UTF8, 0, wstr.data(), static_cast<int>(wstr.size()), NULL, 0, NULL, NULL);
    if (sizeNeeded <= 0) return "";
    std::string str(sizeNeeded, 0);
    WideCharToMultiByte(CP_UTF8, 0, wstr.data(), static_cast<int>(wstr.size()), &str[0], sizeNeeded, NULL, NULL);
    return str;
}

// Escape JSON control characters and quotation marks
static std::string escapeJson(const std::string& input) {
    std::string out;
    out.reserve(input.size() + 16);
    for (char c : input) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned char>(c));
                    out += buf;
                } else {
                    out += c;
                }
                break;
        }
    }
    return out;
}

// Write error JSON to stdout and diagnostic message to stderr, returning exit code 1
static int emitError(const std::string& errorMsg, HRESULT hr = S_OK) {
    std::cerr << "[duoaudio_endpoint ERROR] " << errorMsg;
    if (FAILED(hr)) {
        std::cerr << " (HRESULT: " << formatHresult(hr) << ")";
    }
    std::cerr << std::endl;

    std::string escaped = escapeJson(errorMsg);
    if (FAILED(hr)) {
        std::cout << "{\"success\":false,\"error\":\"" << escaped << "\",\"hresult\":\"" << formatHresult(hr) << "\"}\n";
    } else {
        std::cout << "{\"success\":false,\"error\":\"" << escaped << "\"}\n";
    }
    return 1;
}

// Command: query-default
static int handleQueryDefault() {
    ComPtr<IMMDeviceEnumerator> enumerator;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), NULL, CLSCTX_ALL,
                                 __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
    if (FAILED(hr)) {
        return emitError("CoCreateInstance(MMDeviceEnumerator) failed", hr);
    }

    ComPtr<IMMDevice> dev;
    hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &dev);
    if (FAILED(hr)) {
        return emitError("GetDefaultAudioEndpoint failed", hr);
    }

    LPWSTR devIdRaw = nullptr;
    hr = dev->GetId(&devIdRaw);
    if (FAILED(hr) || !devIdRaw) {
        return emitError("GetId failed", hr);
    }
    std::wstring wId = devIdRaw;
    CoTaskMemFree(devIdRaw);

    std::wstring wName = L"Default Audio Device";
    ComPtr<IPropertyStore> store;
    hr = dev->OpenPropertyStore(STGM_READ, &store);
    if (SUCCEEDED(hr) && store) {
        PROPVARIANT varName;
        PropVariantInit(&varName);
        if (SUCCEEDED(store->GetValue(PKEY_Device_FriendlyName, &varName))) {
            if (varName.vt == VT_LPWSTR && varName.pwszVal) {
                wName = varName.pwszVal;
            }
            PropVariantClear(&varName);
        }
    }

    ComPtr<IAudioEndpointVolume> epv;
    hr = dev->Activate(__uuidof(IAudioEndpointVolume), CLSCTX_ALL, NULL, (void**)&epv);
    if (FAILED(hr)) {
        return emitError("Activate(IAudioEndpointVolume) failed", hr);
    }

    BOOL isMuted = FALSE;
    hr = epv->GetMute(&isMuted);
    if (FAILED(hr)) {
        return emitError("GetMute failed", hr);
    }

    float vol = 0.0f;
    hr = epv->GetMasterVolumeLevelScalar(&vol);
    if (FAILED(hr)) {
        vol = 0.0f;
    }

    std::string strId = escapeJson(wstrToUtf8(wId));
    std::string strName = escapeJson(wstrToUtf8(wName));

    std::ostringstream ss;
    ss << std::fixed << std::setprecision(4) << vol;

    std::cout << "{\"success\":true,\"id\":\"" << strId
              << "\",\"name\":\"" << strName
              << "\",\"isMuted\":" << (isMuted ? "true" : "false")
              << ",\"volume\":" << ss.str() << "}\n";
    return 0;
}

// Command: list-endpoints
static int handleListEndpoints() {
    ComPtr<IMMDeviceEnumerator> enumerator;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), NULL, CLSCTX_ALL,
                                  __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
    if (FAILED(hr)) {
        return emitError("CoCreateInstance(MMDeviceEnumerator) failed", hr);
    }

    ComPtr<IMMDeviceCollection> collection;
    hr = enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &collection);
    if (FAILED(hr)) {
        return emitError("EnumAudioEndpoints failed", hr);
    }

    UINT count = 0;
    hr = collection->GetCount(&count);
    if (FAILED(hr)) {
        return emitError("GetCount failed", hr);
    }

    std::ostringstream ss;
    ss << "{\"success\":true,\"devices\":[";

    for (UINT i = 0; i < count; i++) {
        ComPtr<IMMDevice> dev;
        if (SUCCEEDED(collection->Item(i, &dev))) {
            LPWSTR devIdRaw = nullptr;
            hr = dev->GetId(&devIdRaw);
            std::wstring wId = (SUCCEEDED(hr) && devIdRaw) ? devIdRaw : L"";
            if (devIdRaw) CoTaskMemFree(devIdRaw);

            std::wstring wName = L"Audio Device";
            ComPtr<IPropertyStore> store;
            hr = dev->OpenPropertyStore(STGM_READ, &store);
            if (SUCCEEDED(hr) && store) {
                PROPVARIANT varName;
                PropVariantInit(&varName);
                if (SUCCEEDED(store->GetValue(PKEY_Device_FriendlyName, &varName))) {
                    if (varName.vt == VT_LPWSTR && varName.pwszVal) {
                        wName = varName.pwszVal;
                    }
                    PropVariantClear(&varName);
                }
            }

            if (i > 0) ss << ",";
            ss << "{\"id\":\"" << escapeJson(wstrToUtf8(wId))
               << "\",\"name\":\"" << escapeJson(wstrToUtf8(wName)) << "\"}";
        }
    }

    ss << "]}\n";
    std::cout << ss.str();
    return 0;
}

// Helper: Activate endpoint by ID
static HRESULT getEndpointVolume(const std::wstring& wId, ComPtr<IAudioEndpointVolume>& epv) {
    ComPtr<IMMDeviceEnumerator> enumerator;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), NULL, CLSCTX_ALL,
                                 __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
    if (FAILED(hr)) return hr;

    ComPtr<IMMDevice> dev;
    hr = enumerator->GetDevice(wId.c_str(), &dev);
    if (FAILED(hr)) return hr;

    return dev->Activate(__uuidof(IAudioEndpointVolume), CLSCTX_ALL, NULL, (void**)&epv);
}

// Command: mute-by-id / unmute-by-id
static int handleSetMuteById(const std::wstring& wId, bool targetMute) {
    if (wId.empty()) {
        return emitError("No endpoint ID provided");
    }

    ComPtr<IAudioEndpointVolume> epv;
    HRESULT hr = getEndpointVolume(wId, epv);
    if (FAILED(hr)) {
        return emitError("GetDevice failed (device disconnected or invalid)", hr);
    }

    BOOL oldMute = FALSE;
    hr = epv->GetMute(&oldMute);
    if (FAILED(hr)) {
        return emitError("GetMute failed", hr);
    }

    hr = epv->SetMute(targetMute ? TRUE : FALSE, NULL);
    if (FAILED(hr)) {
        return emitError("SetMute failed", hr);
    }

    BOOL newMute = FALSE;
    hr = epv->GetMute(&newMute);
    if (FAILED(hr)) {
        return emitError("GetMute verification failed", hr);
    }

    if ((targetMute && !newMute) || (!targetMute && newMute)) {
        return emitError("Mute verification failed: state does not match requested target");
    }

    std::string strId = escapeJson(wstrToUtf8(wId));
    std::cout << "{\"success\":true,\"id\":\"" << strId
              << "\",\"oldMute\":" << (oldMute ? "true" : "false")
              << ",\"newMute\":" << (newMute ? "true" : "false") << "}\n";
    return 0;
}

// Command: get-by-id
static int handleGetMuteById(const std::wstring& wId) {
    if (wId.empty()) {
        return emitError("No endpoint ID provided");
    }

    ComPtr<IAudioEndpointVolume> epv;
    HRESULT hr = getEndpointVolume(wId, epv);
    if (FAILED(hr)) {
        return emitError("GetDevice failed (device disconnected or invalid)", hr);
    }

    BOOL isMuted = FALSE;
    hr = epv->GetMute(&isMuted);
    if (FAILED(hr)) {
        return emitError("GetMute failed", hr);
    }

    std::string strId = escapeJson(wstrToUtf8(wId));
    std::cout << "{\"success\":true,\"id\":\"" << strId
              << "\",\"isMuted\":" << (isMuted ? "true" : "false") << "}\n";
    return 0;
}

// Command: set-default-by-id
static int handleSetDefaultById(const std::wstring& wId) {
    if (wId.empty()) {
        return emitError("No endpoint ID provided");
    }

    ComPtr<IPolicyConfig> policyConfig;
    HRESULT hr = CoCreateInstance(CLSID_CPolicyConfigClient, NULL, CLSCTX_ALL,
                                  IID_IPolicyConfig, (void**)&policyConfig);
    if (FAILED(hr)) {
        return emitError("CoCreateInstance(CPolicyConfigClient) failed", hr);
    }

    // Set default endpoint across standard audio roles:
    // eConsole (0) - system sounds, games, default output
    // eMultimedia (1) - music, media players, streaming audio
    // eCommunications (2) - voice calls
    hr = policyConfig->SetDefaultEndpoint(wId.c_str(), eConsole);
    if (FAILED(hr)) {
        return emitError("SetDefaultEndpoint(eConsole) failed", hr);
    }
    hr = policyConfig->SetDefaultEndpoint(wId.c_str(), eMultimedia);
    if (FAILED(hr)) {
        std::cerr << "[duoaudio_endpoint WARNING] SetDefaultEndpoint(eMultimedia) non-fatal error: " << formatHresult(hr) << std::endl;
    }
    hr = policyConfig->SetDefaultEndpoint(wId.c_str(), eCommunications);
    if (FAILED(hr)) {
        std::cerr << "[duoaudio_endpoint WARNING] SetDefaultEndpoint(eCommunications) non-fatal error: " << formatHresult(hr) << std::endl;
    }

    // Verification: Query default audio endpoint to confirm change
    ComPtr<IMMDeviceEnumerator> enumerator;
    hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), NULL, CLSCTX_ALL,
                          __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
    bool verified = false;
    std::wstring verifiedId = L"";
    if (SUCCEEDED(hr)) {
        ComPtr<IMMDevice> dev;
        hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &dev);
        if (SUCCEEDED(hr)) {
            LPWSTR devIdRaw = nullptr;
            hr = dev->GetId(&devIdRaw);
            if (SUCCEEDED(hr) && devIdRaw) {
                verifiedId = devIdRaw;
                CoTaskMemFree(devIdRaw);
                verified = (_wcsicmp(verifiedId.c_str(), wId.c_str()) == 0);
            }
        }
    }

    if (!verified) {
        return emitError("Verification failed: endpoint was not recognized as the active default output");
    }

    std::string strId = escapeJson(wstrToUtf8(wId));
    std::cout << "{\"success\":true,\"id\":\"" << strId
              << "\",\"verified\":true}\n";
    return 0;
}

int wmain(int argc, wchar_t* argv[]) {
    if (argc < 2) {
        return emitError("No action specified");
    }

    ScopedCoInit coInit;
    if (!coInit.succeeded()) {
        return emitError("COM initialization failed (CoInitializeEx)", coInit.hresult());
    }

    std::wstring action = argv[1];

    if (action == L"query-default") {
        return handleQueryDefault();
    } else if (action == L"list-endpoints") {
        return handleListEndpoints();
    } else if (action == L"mute-by-id") {
        if (argc < 3 || wcslen(argv[2]) == 0) {
            return emitError("No endpoint ID provided");
        }
        return handleSetMuteById(argv[2], true);
    } else if (action == L"unmute-by-id") {
        if (argc < 3 || wcslen(argv[2]) == 0) {
            return emitError("No endpoint ID provided");
        }
        return handleSetMuteById(argv[2], false);
    } else if (action == L"get-by-id") {
        if (argc < 3 || wcslen(argv[2]) == 0) {
            return emitError("No endpoint ID provided");
        }
        return handleGetMuteById(argv[2]);
    } else if (action == L"set-default-by-id") {
        if (argc < 3 || wcslen(argv[2]) == 0) {
            return emitError("No endpoint ID provided");
        }
        return handleSetDefaultById(argv[2]);
    } else {
        return emitError("Invalid action specified");
    }
}
