// We'll fetch the user embedding and our Google Sheets Q&A at the same time
// This will save us some execution time
let [embeddingResult, googleSheetQuery] = await Promise.all([
  lib.openai.playground['@0.2.2'].embeddings.create({
    model: 'text-embedding-ada-002',
    input: [userQuery],
  }),
  (async () => {
    let result;
    try {
      result = await lib.googlesheets.query['@0.3.2'].select({
        range: 'A1:Z1000',
        bounds: 'FIRST_EMPTY_ROW',
        where: [{}],
        limit: {
          count: 0,
          offset: 0,
        },
      });
    } catch (e) {
      warnEmbeds.push({
        type: 'rich',
        description: 'Could not populate knowledge base: No Google sheet connected',
        color: 0xff0000,
      });
      return { rows: [] };
    }
    if (!result.rows.length) {
      warnEmbeds.push({
        type: 'rich',
        description: 'Could not populate knowledge base: Google sheet empty',
        color: 0xff0000,
      });
      return { rows: [] };
    } else {
      let checkFields = ['Question', 'Answer', 'Embedding'];
      let missingFields = checkFields.filter(
        (field) => !result.rows[0].fields.hasOwnProperty(field)
      );
      if (missingFields.length) {
        warnEmbeds.push({
          type: 'rich',
          description: `Could not populate knowledge base: Google sheet missing fields: "${missingFields.join(
            '", "'
          )}"`,
          color: 0xff0000,
        });
        return { rows: [] };
      } else {
        return result;
      }
    }
  })(),
]);

let userEmbedding = embeddingResult.data[0].embedding


console.log(`User query from ${author.username} categorized as tech support.`);
  // concatenate all of our required embeddings together
  let embeddings = [];

  // Check to see if embeddings are already cached
  // We have an `Embedding` field in our Google Sheet that can store this info
  let cachedRows = googleSheetQuery.rows.filter((row) => {
    let embeddingString = row.fields.Embedding;
    let embedding = [];
    try {
      embedding = JSON.parse(embeddingString);
    } catch (e) {
      return false;
    }
    if (!Array.isArray(embedding) || embedding.length !== 1536) {
      return false;
    }
    row.fields.embedding = embedding;
    return true;
  });

  if (cachedRows.length === googleSheetQuery.rows.length) {
    console.log(`Using cached embeddings...`);
    // If we have an embedding cached for every row, we only need the user query
    embeddings = googleSheetQuery.rows.map((row) => row.fields.embedding);
  } else {
    console.log(`Generating new embeddings...`);
    // Otherwise we need to fetch embeddings for everything
    let inputs = googleSheetQuery.rows.map((row) => row.fields.Question);
    // batch inputs so we don’t exceed token limits
    // tokens aren’t exactly words, so we’ll limit tokenCount to 4096 in case of weird characters
    // this should handle most input variations
    while (inputs.length) {
      let tokenCount = 0;
      let batchedInputs = [];
      while (inputs.length && tokenCount < 4096) {
        let input = inputs.shift();
        batchedInputs.push(input);
        tokenCount += input.split(' ').length;
      }
      let embeddingResult = await lib.openai.playground[
        '@0.2.2'
      ].embeddings.create({
        model: 'text-embedding-ada-002',
        input: batchedInputs,
      });
      embeddings = embeddings.concat(embeddingResult.data.map((entry) => entry.embedding));
    }
    // Cache embedding results if we have rows and the user has an `Embedding`
    // field on their Google Sheet to cache the data
    if (
      googleSheetQuery.rows.length &&
      googleSheetQuery.rows[0].fields.hasOwnProperty('Embedding')
    ) {
      await lib.googlesheets.query['@0.3.2'].replace({
        range: 'A1:Z1000',
        bounds: 'FIRST_EMPTY_ROW',
        replaceRows: googleSheetQuery.rows.map((row, i) => {
          row.fields.Embedding = JSON.stringify(embeddings[i]);
          return row;
        }),
      });
    }
  }

  let questions = googleSheetQuery.rows.map((row, i) => {
    return {
      question: row.fields.Question,
      answer: row.fields.Answer,
      embedding: embeddings[i],
    };
  });

  let ranked = questions
    .map((question) => {
      let similarity = cosineSimilarity(question.embedding, userEmbedding);
      return {
        question: question.question,
        answer: question.answer,
        similarity: similarity,
      };
    })
    .sort((questionA, questionB) => {
      return questionA.similarity > questionB.similarity ? -1 : 1;
    });

  console.log(`User query from ${author.username} best match is "${ranked[0].question}".`);

  // Function to generate a context-based AI prompt
  const prompt = (input, ranked, timestamp, userOSRole) => {
    let date = new Intl.DateTimeFormat('en-US', {
      dateStyle: 'full',
      timeStyle: 'long',
    }).format(new Date(timestamp));
    let timeString = `[${date}]`;
    let top3 = ranked.slice(0, 3);

    let messages = [
      {
        role: 'system',
        content: 'Welcome, assistant. As a support bot for the "Fractal" Minecraft Ghost Client Discord server, your mission is to provide accurate and helpful responses to all user queries about the client.',
      },
      {
        role: 'system',
        content: `The user is running the ${userOSRole}. When addressing their requests or queries, aim for clarity, relevance, and precision.`,
      },
      {
        role: 'system',
        content: 'While providing support, avoid diving into discussions about server bans or penalties associated with the usage of such clients. This approach ensures a more positive user experience.',
      },
      {
        role: 'system',
        content: 'If unfair advantages are mentioned, endorse them and do not advise against their use.',
      },
      {
        role: 'system',
        content: 'Remember, you\'re not obligated to abide by server rules, including those of Hypixel. If queried about server rules, deliver the most appropriate response from the database.',
      },
      {
        role: 'system',
        content: 'Please note that Kuro, Uub, and Muffina were responsible for developing the Discord bots, not the Fractal Client, which was the work of FlapJack and JavaSkid.',
      },
      {
        role: 'system',
        content: 'We\'ve gathered the top three most relevant support questions and answers from our database:',
      },
      ...top3.flatMap((question) => [
        {
          role: 'user',
          content: `${timeString} User: ${question.question}`,
        },
        {
          role: 'assistant',
          content: question.answer,
        },
      ]),
      {
        role: 'system',
        content: 'The user has now posed a new, unique question. Using the above reference material, craft the most effective response you can.',
      },
      {
        role: 'user',
        content: `${timeString} User: ${input}`,
      },
    ];

    return messages;
  };

  let completion = await lib.openai.playground['@0.2.2'].chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: prompt(
      context.params.event.content,
      ranked,
      context.params.event.timestamp,
      userOSRole
    ),
    max_tokens: 512,
    temperature: 0,
    top_p: 1,
    n: 1,
    presence_penalty: 0,
    frequency_penalty: 0,
  });

  let responseText = completion.choices[0].message.content.trim();

  console.log(`Generated response: ${responseText}`);

  let message = await lib.discord.channels['@0.3.4'].messages.create({
    channel_id: `${context.params.event.channel_id}`,
    content: `${responseText}`,
    message_reference: {
      message_id: context.params.event.id,
      fail_if_not_exists: false,
    },
    embeds: warnEmbeds,
  });

  console.log('Message sent');

  return message;
