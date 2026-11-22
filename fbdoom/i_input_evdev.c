// Linux evdev keyboard input driver for fbDOOM (reads /dev/input/event0).
// Uses explicit Linux evdev keycode constants to avoid macro name collisions with doomkeys.h.

#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/time.h>
#include <unistd.h>

#include "d_event.h"
#include "doomkeys.h"
#include "doomtype.h"
#include "i_system.h"

int vanilla_keyboard_mapping = 1;

static int ev_fd = -1;

// Standard Linux struct input_event (64-bit aarch64)
struct linux_input_event {
    struct timeval time;
    uint16_t type;
    uint16_t code;
    int32_t value;
};

#define EV_KEY_TYPE 1

static int map_evdev_key(uint16_t code) {
    switch (code) {
        case 1:   return KEY_ESCAPE;      // KEY_ESC
        case 2:   return '1';
        case 3:   return '2';
        case 4:   return '3';
        case 5:   return '4';
        case 6:   return '5';
        case 7:   return '6';
        case 8:   return '7';
        case 12:  return KEY_MINUS;       // KEY_MINUS
        case 13:  return KEY_EQUALS;      // KEY_EQUAL
        case 14:  return KEY_BACKSPACE;   // KEY_BACKSPACE
        case 15:  return KEY_TAB;         // KEY_TAB
        case 16:  return 'q';
        case 17:  return KEY_UPARROW;     // KEY_W
        case 18:  return KEY_USE;         // KEY_E
        case 21:  return 'y';
        case 25:  return KEY_PAUSE;       // KEY_P
        case 28:  return KEY_ENTER;       // KEY_ENTER
        case 29:  return KEY_FIRE;        // KEY_LEFTCTRL
        case 30:  return KEY_LEFTARROW;   // KEY_A
        case 31:  return KEY_DOWNARROW;   // KEY_S
        case 32:  return KEY_RIGHTARROW;  // KEY_D
        case 33:  return KEY_FIRE;        // KEY_F
        case 42:  return KEY_RSHIFT;      // KEY_LEFTSHIFT
        case 49:  return 'n';
        case 51:  return KEY_STRAFE_L;    // KEY_COMMA
        case 52:  return KEY_STRAFE_R;    // KEY_DOT
        case 54:  return KEY_RSHIFT;      // KEY_RIGHTSHIFT
        case 56:  return KEY_RALT;        // KEY_LEFTALT
        case 57:  return KEY_USE;         // KEY_SPACE
        case 59:  return KEY_F1;
        case 60:  return KEY_F2;
        case 61:  return KEY_F3;
        case 62:  return KEY_F4;
        case 63:  return KEY_F5;
        case 64:  return KEY_F6;
        case 65:  return KEY_F7;
        case 66:  return KEY_F8;
        case 67:  return KEY_F9;
        case 68:  return KEY_F10;
        case 96:  return KEY_ENTER;       // KEY_KPENTER
        case 97:  return KEY_FIRE;        // KEY_RIGHTCTRL
        case 100: return KEY_RALT;        // KEY_RIGHTALT
        case 103: return KEY_UPARROW;     // KEY_UP
        case 105: return KEY_LEFTARROW;   // KEY_LEFT
        case 106: return KEY_RIGHTARROW;  // KEY_RIGHT
        case 108: return KEY_DOWNARROW;   // KEY_DOWN
        default:  return 0;
    }
}

void kbd_shutdown(void) {
    if (ev_fd >= 0) {
        close(ev_fd);
        ev_fd = -1;
    }
}

void I_InitInput(void) {
    ev_fd = open("/dev/input/event0", O_RDONLY | O_NONBLOCK);
    if (ev_fd < 0) {
        fprintf(stderr, "I_InitInput: could not open /dev/input/event0\n");
    }
}

void I_GetEvent(void) {
    if (ev_fd < 0) return;

    struct linux_input_event ev;
    while (read(ev_fd, &ev, sizeof(ev)) == (ssize_t)sizeof(ev)) {
        if (ev.type != EV_KEY_TYPE) continue;
        if (ev.value != 0 && ev.value != 1) continue;

        int doom_key = map_evdev_key(ev.code);
        if (!doom_key) continue;

        event_t de;
        de.type = ev.value ? ev_keydown : ev_keyup;
        de.data1 = doom_key;
        de.data2 = (ev.value && doom_key >= 32 && doom_key < 127) ? doom_key : 0;
        de.data3 = 0;
        D_PostEvent(&de);
    }
}
