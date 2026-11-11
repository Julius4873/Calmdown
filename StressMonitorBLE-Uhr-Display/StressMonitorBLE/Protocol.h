#pragma once
#include <stdint.h>
#include <cmath>
namespace Protocol {
constexpr char service[] = "89e10001-3b55-4a92-9b4d-173a6a0d8200";
constexpr char measurements[] = "89e10002-3b55-4a92-9b4d-173a6a0d8200";
constexpr char clock[] = "89e10003-3b55-4a92-9b4d-173a6a0d8200";
inline void u16(uint8_t *p, uint16_t v) { p[0] = v; p[1] = v >> 8; }
inline void u32(uint8_t *p, uint32_t v) { for (int i=0;i<4;++i) p[i]=v>>(8*i); }
inline uint16_t rate(float v) { return std::isfinite(v) && v >= 0 && v < 6553.5f ? uint16_t(std::lround(v*10)) : 65535; }
inline void encode(uint8_t *p, uint16_t seq, uint32_t uptime, float hr, float rr,
                   uint16_t adc, uint16_t ir, uint16_t red, uint8_t phase, bool sensor, bool demo) {
  p[0]=1; p[1]=(sensor?1:0)|(std::isfinite(hr)?2:0)|(std::isfinite(rr)?4:0)|
       (phase==2?8:0)|(phase==3?16:0)|(demo?32:0);
  u16(p+2,seq); u32(p+4,uptime); u16(p+8,rate(hr)); u16(p+10,rate(rr));
  u16(p+12,adc); u16(p+14,ir); u16(p+16,red); p[18]=phase; p[19]=0;
}
}
