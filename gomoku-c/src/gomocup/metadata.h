//
//  metadata.h
//  gomoku-c — Gomocup brain
//
//  Compile-time strings used in the ABOUT response. The ABOUT line MUST
//  be a single line of comma-separated key="value" pairs, per the
//  Gomocup AI Protocol v2 spec (https://plastovicka.github.io/protocl2en.htm).
//

#ifndef GOMOCUP_METADATA_H
#define GOMOCUP_METADATA_H

#define GOMOCUP_BRAIN_NAME "kig-standard"
#define GOMOCUP_BRAIN_VERSION "1.0.0"
#define GOMOCUP_BRAIN_AUTHOR "Konstantin Gredeskoul"
#define GOMOCUP_BRAIN_COUNTRY "USA"
#define GOMOCUP_BRAIN_WWW "https://kig.re"
#define GOMOCUP_BRAIN_EMAIL "kigster@gmail.com"

#define GOMOCUP_ABOUT_LINE                                                     \
  "name=\"" GOMOCUP_BRAIN_NAME "\", "                                          \
  "version=\"" GOMOCUP_BRAIN_VERSION "\", "                                    \
  "author=\"" GOMOCUP_BRAIN_AUTHOR "\", "                                      \
  "country=\"" GOMOCUP_BRAIN_COUNTRY "\", "                                    \
  "www=\"" GOMOCUP_BRAIN_WWW "\", "                                            \
  "email=\"" GOMOCUP_BRAIN_EMAIL "\""

#endif // GOMOCUP_METADATA_H
