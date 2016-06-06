import { fromPairs, identity, constant } from 'lodash'
import { $$rowTable } from '../../symbols.js'
import SQLBuilder from '../../SQLBuilder.js'
import getColumnType from '../getColumnType.js'
import createTableType from '../createTableType.js'
import { createTableEdgeType } from '../createConnectionType.js'
import getPayloadInterface from './getPayloadInterface.js'
import getPayloadFields from './getPayloadFields.js'
import { createTableOrderingEnum } from '../createConnectionArgs.js'
import { inputClientMutationId } from './clientMutationId.js'

import {
  getNullableType,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLInputObjectType,
} from 'graphql'

/**
 * Creates a mutation which will create a new row.
 *
 * @param {Table} table
 * @returns {GraphQLFieldConfig}
 */
const createInsertMutationField = table => ({
  type: createPayloadType(table),
  description: `Creates a new node of the ${table.getMarkdownTypeName()} type.`,

  args: {
    input: {
      type: new GraphQLNonNull(createInputType(table)),
    },
  },

  resolve: resolveInsert(table),
})

export default createInsertMutationField

const createInputType = table =>
  new GraphQLInputObjectType({
    name: `Insert${table.getTypeName()}Input`,
    description: `The ${table.getMarkdownTypeName()} to insert.`,

    fields: {
      ...fromPairs(
        table.getColumns().map(column => [column.getFieldName(), {
          type: (column.hasDefault ? getNullableType : identity)(getColumnType(column)),
          description: column.description,
        }]),
      ),
      clientMutationId: inputClientMutationId,
    },
  })

const createPayloadType = table =>
  new GraphQLObjectType({
    name: `Insert${table.getTypeName()}Payload`,
    description: `Contains the ${table.getMarkdownTypeName()} node inserted by the mutation.`,
    interfaces: [getPayloadInterface(table.schema)],

    fields: {
      [table.getFieldName()]: {
        type: createTableType(table),
        description: `The inserted ${table.getMarkdownTypeName()}.`,
        resolve: ({ output }) => output,
      },

      [`${table.getFieldName()}Edge`]: {
        type: createTableEdgeType(table),
        args: {
          orderBy: {
            type: createTableOrderingEnum(table),
          },
        },
        description: 'An edge to be inserted in a connection with help of the containing cursor.',
        resolve: resolveNewEdge(table),
      },

      ...getPayloadFields(table.schema),
    },
  })

const resolveNewEdge = table => ({ output }, { orderBy }) => {
  // See http://stackoverflow.com/a/32615799/1140494
  let cursor = null

  // if the edge field was handed an orderBy argument we use
  // this as the cursor
  if (orderBy) {
    cursor = output[orderBy]
  }
  // if orderBy is not present use the primary keys of the table
  else {
    const primaryKeys = table.getPrimaryKeys()
    cursor = primaryKeys.map(column => output[column.name])
  }

  return {
    cursor,
    node: output,
  }
}

const resolveInsert = table => {
  // Note that using `DataLoader` here would not make very minor performance
  // improvements because mutations are executed in sequence, not parallel.
  //
  // A better solution for batch inserts is a custom batch insert field.
  const columns = table.getColumns()

  return async (source, args, { client }) => {
    // Get the input object value from the args.
    const { input } = args
    const { clientMutationId } = input

    const valueEntries = (
      columns
      .map(column => [column, input[column.getFieldName()]])
      .filter(([, value]) => value)
    )

    // Insert the thing making sure we return the newly inserted row.
    const { rows: [row] } = await client.queryAsync(
      new SQLBuilder()
      .add(`insert into ${table.getIdentifier()}`)
      .add(`(${valueEntries.map(([column]) => `"${column.name}"`).join(', ')})`)
      .add('values')
      .add(`(${valueEntries.map(constant('$')).join(', ')})`, valueEntries.map(([, value]) => value))
      .add('returning *')
    )

    const output = row ? (row[$$rowTable] = table, row) : null

    return {
      output,
      clientMutationId,
    }
  }
}
