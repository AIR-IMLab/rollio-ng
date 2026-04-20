add_executable(rollio-device-realsense src/main.cpp)
target_link_libraries(rollio-device-realsense PRIVATE rollio-common)

# `realsense2` is the static target produced by
# third_party/librealsense/CMakeLists.txt (BUILD_SHARED_LIBS=OFF is forced
# in cameras/CMakeLists.txt before that add_subdirectory). Linking against
# it pulls the librealsense closure in statically; the only remaining
# runtime deps are libusb-1.0 and libudev, both standard Ubuntu apt
# packages and discoverable by dpkg-shlibdeps.
target_link_libraries(rollio-device-realsense PRIVATE realsense2)
target_compile_definitions(rollio-device-realsense PRIVATE ROLLIO_HAVE_REALSENSE=1)

if(ROLLIO_BUILD_CPP_TESTS)
    add_executable(rollio-device-realsense-tests tests/runtime.cpp)
    target_link_libraries(rollio-device-realsense-tests PRIVATE rollio-common)
    target_compile_definitions(
        rollio-device-realsense-tests
        PRIVATE
        ROLLIO_DEVICE_REALSENSE_BIN="$<TARGET_FILE:rollio-device-realsense>"
    )
    add_test(NAME rollio-device-realsense-tests COMMAND rollio-device-realsense-tests)
endif()
