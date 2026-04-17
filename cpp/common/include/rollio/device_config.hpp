#ifndef ROLLIO_DEVICE_CONFIG_HPP
#define ROLLIO_DEVICE_CONFIG_HPP

#include <charconv>
#include <cctype>
#include <cstdint>
#include <fstream>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "rollio/types.h"

namespace rollio {

// ---------------------------------------------------------------------------
// Binary device contract (per-process device TOML, matches rollio-types)
// ---------------------------------------------------------------------------

struct CameraChannelProfile {
    uint32_t width{0};
    uint32_t height{0};
    uint32_t fps{0};
    PixelFormat pixel_format{PixelFormat::Rgb24};
};

struct DeviceChannelConfigV2 {
    std::string channel_type;
    DeviceKind kind{DeviceKind::Camera};
    bool enabled{true};
    std::optional<CameraChannelProfile> profile;
    /// RealSense infrared sensor index (1-based RS convention); unset uses 1.
    std::optional<uint32_t> stream_index;
};

struct BinaryDeviceConfig {
    std::string name;
    std::optional<std::string> executable;
    std::string driver;
    std::string id;
    std::string bus_root;
    std::vector<DeviceChannelConfigV2> channels;
};

// ---------------------------------------------------------------------------
// Legacy flat camera device config (e.g. rollio-camera-pseudo)
// ---------------------------------------------------------------------------

struct CameraDeviceConfig {
    std::string name;
    std::string type;
    std::string driver;
    std::string id;
    uint32_t width{0};
    uint32_t height{0};
    uint32_t fps{0};
    PixelFormat pixel_format{PixelFormat::Rgb24};
    std::optional<std::string> stream;
    std::optional<uint32_t> channel;
    std::optional<std::string> transport;
};

namespace detail {

inline auto trim(std::string value) -> std::string {
    auto is_space = [](const unsigned char ch) -> bool {
        return ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n';
    };

    while (!value.empty() && is_space(static_cast<unsigned char>(value.front()))) {
        value.erase(value.begin());
    }
    while (!value.empty() && is_space(static_cast<unsigned char>(value.back()))) {
        value.pop_back();
    }

    return value;
}

inline auto strip_quotes(std::string value) -> std::string {
    value = trim(std::move(value));
    if (value.size() >= 2 && value.front() == '"' && value.back() == '"') {
        return value.substr(1, value.size() - 2);
    }
    return value;
}

inline auto strip_comment(std::string value) -> std::string {
    auto in_quotes = false;
    for (std::size_t idx = 0; idx < value.size(); ++idx) {
        if (value[idx] == '"') {
            in_quotes = !in_quotes;
        } else if (value[idx] == '#' && !in_quotes) {
            value.erase(idx);
            break;
        }
    }
    return trim(std::move(value));
}

inline auto parse_u32(const std::unordered_map<std::string, std::string>& values, const std::string& key)
    -> uint32_t {
    const auto it = values.find(key);
    if (it == values.end()) {
        throw std::runtime_error("missing required key: " + key);
    }

    uint32_t value = 0;
    const auto raw = trim(it->second);
    const auto* begin = raw.data();
    const auto* end = raw.data() + raw.size();
    const auto [ptr, error] = std::from_chars(begin, end, value);
    if (error != std::errc{} || ptr != end) {
        throw std::runtime_error("failed to parse integer key: " + key);
    }
    return value;
}

inline auto parse_optional_u32(const std::unordered_map<std::string, std::string>& values,
                               const std::string& key) -> std::optional<uint32_t> {
    const auto it = values.find(key);
    if (it == values.end()) {
        return std::nullopt;
    }
    return parse_u32(values, key);
}

inline auto parse_required_string(const std::unordered_map<std::string, std::string>& values,
                                  const std::string& key) -> std::string {
    const auto it = values.find(key);
    if (it == values.end()) {
        throw std::runtime_error("missing required key: " + key);
    }

    const auto value = strip_quotes(it->second);
    if (value.empty()) {
        throw std::runtime_error("key must not be empty: " + key);
    }
    return value;
}

inline auto parse_optional_string(const std::unordered_map<std::string, std::string>& values,
                                  const std::string& key) -> std::optional<std::string> {
    const auto it = values.find(key);
    if (it == values.end()) {
        return std::nullopt;
    }
    return strip_quotes(it->second);
}

inline auto parse_bool_value(std::string_view raw) -> bool {
    auto lowered = std::string(trim(std::string(raw)));
    for (auto& ch : lowered) {
        ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    }
    if (lowered == "true") {
        return true;
    }
    if (lowered == "false") {
        return false;
    }
    throw std::runtime_error("expected boolean true/false, got: " + std::string(raw));
}

inline auto parse_simple_toml(std::string_view text)
    -> std::unordered_map<std::string, std::string> {
    std::unordered_map<std::string, std::string> values;
    std::size_t cursor = 0;

    while (cursor <= text.size()) {
        const auto next_newline = text.find('\n', cursor);
        const auto line_end = next_newline == std::string_view::npos ? text.size() : next_newline;
        auto line = strip_comment(std::string(text.substr(cursor, line_end - cursor)));
        cursor = line_end == text.size() ? text.size() + 1 : line_end + 1;

        if (line.empty()) {
            continue;
        }
        if (line.front() == '[') {
            throw std::runtime_error("legacy device config must not contain TOML tables");
        }

        const auto separator = line.find('=');
        if (separator == std::string::npos) {
            throw std::runtime_error("invalid TOML line: " + line);
        }

        auto key = trim(line.substr(0, separator));
        auto value = trim(line.substr(separator + 1));
        if (key.empty()) {
            throw std::runtime_error("invalid TOML key");
        }
        values[key] = value;
    }

    return values;
}

inline auto split_key_value(const std::string& line) -> std::pair<std::string, std::string> {
    const auto separator = line.find('=');
    if (separator == std::string::npos) {
        throw std::runtime_error("invalid TOML line: " + line);
    }
    auto key = trim(line.substr(0, separator));
    auto value = trim(line.substr(separator + 1));
    if (key.empty()) {
        throw std::runtime_error("invalid TOML key");
    }
    return {key, value};
}

inline auto extract_braced_inline_table(std::string_view value) -> std::string {
    auto trimmed = trim(std::string(value));
    const auto open = trimmed.find('{');
    const auto close = trimmed.rfind('}');
    if (open == std::string::npos || close == std::string::npos || close <= open) {
        throw std::runtime_error("expected inline table { ... }");
    }
    return trim(trimmed.substr(open + 1, close - open - 1));
}

inline auto parse_inline_table_map(std::string_view inner)
    -> std::unordered_map<std::string, std::string> {
    std::unordered_map<std::string, std::string> out;
    std::size_t pos = 0;
    while (pos < inner.size()) {
        while (pos < inner.size() && (inner[pos] == ' ' || inner[pos] == '\t' || inner[pos] == ',')) {
            ++pos;
        }
        if (pos >= inner.size()) {
            break;
        }
        const auto eq = inner.find('=', pos);
        if (eq == std::string::npos) {
            throw std::runtime_error("invalid inline table fragment");
        }
        auto key = trim(std::string(inner.substr(pos, eq - pos)));
        pos = eq + 1;
        while (pos < inner.size() && (inner[pos] == ' ' || inner[pos] == '\t')) {
            ++pos;
        }
        if (pos >= inner.size()) {
            throw std::runtime_error("missing value in inline table for key: " + key);
        }
        std::string raw_value;
        if (inner[pos] == '"') {
            const auto start = pos;
            ++pos;
            while (pos < inner.size() && inner[pos] != '"') {
                if (inner[pos] == '\\' && pos + 1 < inner.size()) {
                    raw_value.push_back(static_cast<char>(inner[pos + 1]));
                    pos += 2;
                } else {
                    raw_value.push_back(static_cast<char>(inner[pos]));
                    ++pos;
                }
            }
            if (pos >= inner.size() || inner[pos] != '"') {
                throw std::runtime_error("unterminated string in inline table");
            }
            ++pos;
        } else {
            const auto start = pos;
            while (pos < inner.size() && inner[pos] != ',' && inner[pos] != ' ' && inner[pos] != '\t') {
                ++pos;
            }
            raw_value = trim(std::string(inner.substr(start, pos - start)));
        }
        out[key] = raw_value;
    }
    return out;
}

inline auto parse_profile_from_value(const std::string& value) -> CameraChannelProfile {
    const auto inner = extract_braced_inline_table(value);
    const auto fields = parse_inline_table_map(inner);
    CameraChannelProfile profile;
    profile.width = parse_u32(fields, "width");
    profile.height = parse_u32(fields, "height");
    profile.fps = parse_u32(fields, "fps");
    const auto pixel_format_name = parse_required_string(fields, "pixel_format");
    const auto pixel_format = pixel_format_from_string(pixel_format_name);
    if (!pixel_format.has_value()) {
        throw std::runtime_error("unsupported pixel_format: " + pixel_format_name);
    }
    profile.pixel_format = *pixel_format;
    return profile;
}

inline auto parse_binary_device_config(std::string_view text) -> BinaryDeviceConfig {
    BinaryDeviceConfig device;
    enum class Section { Root, Channel };
    auto section = Section::Root;

    std::size_t cursor = 0;
    while (cursor <= text.size()) {
        const auto next_newline = text.find('\n', cursor);
        const auto line_end = next_newline == std::string_view::npos ? text.size() : next_newline;
        auto line = strip_comment(std::string(text.substr(cursor, line_end - cursor)));
        cursor = line_end == text.size() ? text.size() + 1 : line_end + 1;

        if (line.empty()) {
            continue;
        }

        const auto trimmed = trim(line);
        if (trimmed.front() == '[') {
            if (trimmed == "[[channels]]" || trimmed == "[[devices.channels]]") {
                device.channels.emplace_back();
                section = Section::Channel;
                continue;
            }
            throw std::runtime_error("unsupported TOML table header: " + trimmed);
        }

        const auto [key, raw_value] = split_key_value(line);

        if (section == Section::Root) {
            if (key == "name") {
                device.name = strip_quotes(raw_value);
            } else if (key == "executable") {
                device.executable = strip_quotes(raw_value);
            } else if (key == "driver") {
                device.driver = strip_quotes(raw_value);
            } else if (key == "id") {
                device.id = strip_quotes(raw_value);
            } else if (key == "bus_root") {
                device.bus_root = strip_quotes(raw_value);
            } else {
                // Forward-compatible: ignore unknown root keys (matches serde flatten/extra usage).
            }
        } else {
            if (device.channels.empty()) {
                throw std::runtime_error("channel key before first [[channels]] table");
            }
            auto& ch = device.channels.back();
            if (key == "channel_type") {
                ch.channel_type = strip_quotes(raw_value);
            } else if (key == "kind") {
                const auto kind = device_kind_from_string(strip_quotes(raw_value));
                if (!kind.has_value()) {
                    throw std::runtime_error("unsupported channel kind");
                }
                ch.kind = *kind;
            } else if (key == "enabled") {
                ch.enabled = parse_bool_value(raw_value);
            } else if (key == "profile") {
                ch.profile = parse_profile_from_value(raw_value);
            } else if (key == "stream_index") {
                uint32_t v = 0;
                const auto s = trim(raw_value);
                const auto* b = s.data();
                const auto* e = s.data() + s.size();
                const auto [ptr, err] = std::from_chars(b, e, v);
                if (err != std::errc{} || ptr != e) {
                    throw std::runtime_error("invalid stream_index");
                }
                ch.stream_index = v;
            } else {
                // Ignore unknown channel keys (extra / future fields).
            }
        }
    }

    if (device.name.empty() || device.driver.empty() || device.id.empty() || device.bus_root.empty()) {
        throw std::runtime_error("binary device config requires name, driver, id, and bus_root");
    }
    if (device.channels.empty()) {
        throw std::runtime_error("binary device config requires at least one [[channels]] entry");
    }
    return device;
}

}  // namespace detail

inline auto parse_camera_device_config(std::string_view text) -> CameraDeviceConfig {
    const auto values = detail::parse_simple_toml(text);

    CameraDeviceConfig config;
    config.name = detail::parse_required_string(values, "name");
    config.type = detail::parse_required_string(values, "type");
    config.driver = detail::parse_required_string(values, "driver");
    config.id = detail::parse_required_string(values, "id");
    config.width = detail::parse_u32(values, "width");
    config.height = detail::parse_u32(values, "height");
    config.fps = detail::parse_u32(values, "fps");
    config.stream = detail::parse_optional_string(values, "stream");
    config.channel = detail::parse_optional_u32(values, "channel");
    config.transport = detail::parse_optional_string(values, "transport");

    const auto pixel_format_name = detail::parse_required_string(values, "pixel_format");
    const auto pixel_format = pixel_format_from_string(pixel_format_name);
    if (!pixel_format.has_value()) {
        throw std::runtime_error("unsupported pixel_format: " + pixel_format_name);
    }
    config.pixel_format = *pixel_format;

    return config;
}

inline auto parse_binary_device_config(std::string_view text) -> BinaryDeviceConfig {
    return detail::parse_binary_device_config(text);
}

inline auto load_camera_device_config_from_file(const std::string& path) -> CameraDeviceConfig {
    std::ifstream file(path);
    if (!file.is_open()) {
        throw std::runtime_error("failed to open config file: " + path);
    }

    std::string text((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    return parse_camera_device_config(text);
}

inline auto load_binary_device_config_from_file(const std::string& path) -> BinaryDeviceConfig {
    std::ifstream file(path);
    if (!file.is_open()) {
        throw std::runtime_error("failed to open config file: " + path);
    }
    std::string text((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    return parse_binary_device_config(text);
}

}  // namespace rollio

#endif  // ROLLIO_DEVICE_CONFIG_HPP
