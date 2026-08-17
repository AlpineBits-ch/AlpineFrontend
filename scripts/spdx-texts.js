/**
 * Licence text for packages that ship none of their own.
 *
 * Two tiers, and the split is deliberate. Short licences are inlined here because their text is
 * fixed, universally agreed and small enough to audit by eye. Long ones are NOT inlined - they are
 * harvested at generation time from a package in the dependency tree that does ship the file, so
 * the text is a verbatim copy of something already on disk rather than something typed out from
 * memory. A licence reproduced inaccurately is worse than one omitted, because it looks authorised.
 *
 * The inlined texts below carry no copyright line; the generator prepends one built from the
 * package's own metadata, since the holder differs per package.
 */

const MIT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const MIT_0 = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const ISC_DISCLAIMER = `THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.`;

const ISC = `Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

${ISC_DISCLAIMER}`;

const ZERO_BSD = `Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

${ISC_DISCLAIMER}`;

const BSD_DISCLAIMER = `THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;

const BSD_1 = `Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following condition is met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

${BSD_DISCLAIMER}`;

const BSD_2 = `Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

${BSD_DISCLAIMER}`;

const BSD_3 = `Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

${BSD_DISCLAIMER}`;

const ZLIB = `This software is provided 'as-is', without any express or implied warranty. In
no event will the authors be held liable for any damages arising from the use
of this software.

Permission is granted to anyone to use this software for any purpose, including
commercial applications, and to alter it and redistribute it freely, subject to
the following restrictions:

1. The origin of this software must not be misrepresented; you must not claim
   that you wrote the original software. If you use this software in a product,
   an acknowledgment in the product documentation would be appreciated but is
   not required.

2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.

3. This notice may not be removed or altered from any source distribution.`;

/** Short, stable licence bodies safe to inline. */
const INLINE_TEXTS = {
    'MIT': MIT,
    'MIT-0': MIT_0,
    'ISC': ISC,
    '0BSD': ZERO_BSD,
    'BSD-1-Clause': BSD_1,
    'BSD-2-Clause': BSD_2,
    'BSD-3-Clause': BSD_3,
    'Zlib': ZLIB,
};

/**
 * Long licences, harvested from the tree instead of inlined. The regex identifies a candidate file
 * as being that licence; the first match wins and its bytes are copied verbatim.
 *
 * Every id here must be findable somewhere in the tree. If one is not, the generator fails rather
 * than emitting a package with no terms attached.
 */
const HARVEST_MARKERS = {
    'Apache-2.0': /Apache License\s*\n?\s*Version 2\.0/i,
    'MPL-2.0': /Mozilla Public License Version 2\.0/i,
    'FSL-1.1-MIT': /Functional Source License, Version 1\.1, MIT Future License/i,
    'OFL-1.1': /SIL OPEN FONT LICENSE\s*\n?\s*Version 1\.1/i,
    'CC-BY-4.0': /Creative Commons Attribution 4\.0 International/i,
    'Unicode-3.0': /UNICODE LICENSE V3/i,
    'BSL-1.0': /Boost Software License - Version 1\.0/i,
    'CC0-1.0': /CC0 1\.0 Universal/i,
    'Unlicense': /This is free and unencumbered software released into the public domain/i,
    'CDLA-Permissive-2.0': /Community Data License Agreement - Permissive - Version 2\.0/i,
};

/**
 * Which side of an `OR` to take. Earlier wins. MIT and the BSD family lead because their terms are
 * the shortest to satisfy - a copyright line and a permission notice - and every dual-licensed
 * crate in this tree offers one of them.
 */
const PREFERENCE = [
    'MIT',
    'MIT-0',
    'ISC',
    '0BSD',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'BSD-1-Clause',
    'Zlib',
    'Apache-2.0',
    'Unlicense',
    'CC0-1.0',
    'BSL-1.0',
    'Unicode-3.0',
    'MPL-2.0',
    'OFL-1.1',
    'CC-BY-4.0',
    'CDLA-Permissive-2.0',
];

module.exports = {INLINE_TEXTS, HARVEST_MARKERS, PREFERENCE};
