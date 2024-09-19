export class Tokenizer {
  private static counter: number = 0;
  private static map1: Map<number, string> = new Map();
  private static map2: Map<string, number> = new Map();
  private static splitOn: Set<string> = new Set(['#', ':', '_', '=']);

  public static detokenize(tokenized: Array<number | string>): string {
    return tokenized
      .map((x) => (typeof x === 'number' ? Tokenizer.map1.get(x) : x))
      .join('');
  }

  public static tokenize(str: string): Array<number | string> {
    const result: Array<number | string> = [];
    let startIndex = 0;

    for (let i = 0; i < str.length; i++) {
      // Check if the current character is part of the delimiter
      if (Tokenizer.splitOn.has(str[i])) {
        if (startIndex < i) {
          const segment = str.substring(startIndex, i);
          const existing = Tokenizer.map2.get(segment);
          if (existing != null) {
            result.push(existing);
          } else {
            const index = Tokenizer.counter++;
            Tokenizer.map1.set(index, segment);
            Tokenizer.map2.set(segment, index);
            result.push(index);
          }
        }
        // Add the delimiter to the result if it's not the last segment
        if (i < str.length - 1) {
          result.push(str[i]);
        }
        startIndex = i + 1; // Update the start index to the next character
      }
    }

    // Process the last segment if it exists
    if (startIndex < str.length) {
      const segment = str.substring(startIndex);
      const existing = Tokenizer.map2.get(segment);
      if (existing != null) {
        result.push(existing);
      } else {
        const index = Tokenizer.counter++;
        Tokenizer.map1.set(index, segment);
        Tokenizer.map2.set(segment, index);
        result.push(index);
      }
    }

    return result;
  }
}
