"""Minimal port of lz-string's decompressFromBase64 (the encoding SudokuPad and f-puzzles use)."""

_KEY = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
_VAL = {ch: i for i, ch in enumerate(_KEY)}


def decompress_from_base64(data):
    if data is None:
        return ""
    if data == "":
        return None
    try:
        values = [_VAL[ch] for ch in data]
    except KeyError:
        return None
    return _decompress(len(values), 32, lambda i: values[i])


def _decompress(length, reset_value, get_next_value):
    dictionary = {0: 0, 1: 1, 2: 2}
    enlarge_in = 4
    dict_size = 4
    num_bits = 3
    result = []
    state = {"val": get_next_value(0), "position": reset_value, "index": 1}

    def read_bits(n):
        bits = 0
        power = 1
        maxpower = 1 << n
        while power != maxpower:
            resb = state["val"] & state["position"]
            state["position"] >>= 1
            if state["position"] == 0:
                state["position"] = reset_value
                if state["index"] >= length:
                    state["val"] = 0
                else:
                    state["val"] = get_next_value(state["index"])
                state["index"] += 1
            bits |= (1 if resb > 0 else 0) * power
            power <<= 1
        return bits

    nxt = read_bits(2)
    if nxt == 0:
        c = chr(read_bits(8))
    elif nxt == 1:
        c = chr(read_bits(16))
    else:
        return ""
    dictionary[3] = c
    w = c
    result.append(c)

    while True:
        if state["index"] > length + 1:
            return None
        cc = read_bits(num_bits)
        if cc == 0:
            dictionary[dict_size] = chr(read_bits(8))
            cc = dict_size
            dict_size += 1
            enlarge_in -= 1
        elif cc == 1:
            dictionary[dict_size] = chr(read_bits(16))
            cc = dict_size
            dict_size += 1
            enlarge_in -= 1
        elif cc == 2:
            return "".join(result)

        if enlarge_in == 0:
            enlarge_in = 1 << num_bits
            num_bits += 1

        if cc in dictionary:
            entry = dictionary[cc]
        elif cc == dict_size:
            entry = w + w[0]
        else:
            return None
        result.append(entry)

        dictionary[dict_size] = w + entry[0]
        dict_size += 1
        enlarge_in -= 1
        w = entry

        if enlarge_in == 0:
            enlarge_in = 1 << num_bits
            num_bits += 1
