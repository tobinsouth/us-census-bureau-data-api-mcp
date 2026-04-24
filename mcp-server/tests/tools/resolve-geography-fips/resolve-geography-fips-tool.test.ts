vi.mock('../../../src/services/metadata.service.js', () => ({
  getMetadataService: vi.fn(),
}))

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
  Mock,
} from 'vitest'

import {
  validateResponseStructure,
  validateToolStructure,
} from '../../helpers/test-utils'

import { getMetadataService } from '../../../src/services/metadata.service.js'
import {
  ResolveGeographyFipsTool,
  toolDescription,
} from '../../../src/tools/resolve-geography-fips.tool'
import { GeographySearchResultRow } from '../../../src/types/geography.types'

const defaultArgs = {
  geography_name: 'Philadelphia, Pennsylvania',
}

const summaryLevelArgs = {
  ...defaultArgs,
  summary_level: '160',
}

describe('ResolveGeographyFipsTool', () => {
  let tool: ResolveGeographyFipsTool
  let mockMetadata: {
    healthCheck: Mock
    getSummaryLevels: Mock
    searchSummaryLevels: Mock
    searchGeographies: Mock
    searchGeographiesBySummaryLevel: Mock
    searchDataTables: Mock
  }

  let mockGeographies: GeographySearchResultRow[]

  beforeAll(() => {
    mockMetadata = {
      healthCheck: vi.fn(),
      getSummaryLevels: vi.fn(),
      searchSummaryLevels: vi.fn(),
      searchGeographies: vi.fn(),
      searchGeographiesBySummaryLevel: vi.fn(),
      searchDataTables: vi.fn(),
    }
    ;(getMetadataService as Mock).mockReturnValue(mockMetadata)
  })

  beforeEach(() => {
    mockMetadata.healthCheck.mockReset().mockResolvedValue(true)
    mockMetadata.searchSummaryLevels
      .mockReset()
      .mockResolvedValue([{ code: '160', name: 'Place' }])
    mockMetadata.searchGeographies.mockReset().mockResolvedValue([])
    mockMetadata.searchGeographiesBySummaryLevel
      .mockReset()
      .mockResolvedValue([])

    tool = new ResolveGeographyFipsTool()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('should have the correct metadata', () => {
    validateToolStructure(tool)
    expect(tool.name).toBe('resolve-geography-fips')
    expect(tool.description).toBe(toolDescription)
    expect(tool.requiresApiKey).toBe(false)
  })

  it('should have valid input schema', () => {
    const schema = tool.inputSchema

    expect(schema.type).toBe('object')
    expect(schema.properties).toHaveProperty('geography_name')
    expect(schema.properties).toHaveProperty('summary_level')
    expect(schema.required).toEqual(['geography_name'])
  })

  it('should have matching args schema', () => {
    expect(() => tool.argsSchema.parse(defaultArgs)).not.toThrow()
  })

  describe('Database Integration', () => {
    it('should check metadata health', async () => {
      await tool.handler(defaultArgs)

      expect(mockMetadata.healthCheck).toHaveBeenCalled()
    })

    it('should return error when metadata is unhealthy', async () => {
      mockMetadata.healthCheck.mockResolvedValue(false)

      const response = await tool.handler(defaultArgs)
      validateResponseStructure(response)
      expect(response.content[0].text).toContain(
        'Database connection failed - cannot retrieve geography metadata',
      )
    })

    it('should surface metadata errors', async () => {
      mockMetadata.searchGeographies.mockRejectedValue(
        new Error('Database connection failed'),
      )

      const response = await tool.handler(defaultArgs)
      validateResponseStructure(response)
      expect(response.content[0].text).toContain('Database connection failed')
    })

    describe('when only the geography_name is provided', () => {
      it('should call searchGeographies', async () => {
        await tool.handler(defaultArgs)

        expect(mockMetadata.searchGeographies).toHaveBeenCalledWith(
          defaultArgs.geography_name,
        )
        expect(mockMetadata.searchSummaryLevels).not.toHaveBeenCalled()
      })
    })

    describe('when the geography_name and summary_level_code are provided', () => {
      it('should call searchGeographiesBySummaryLevel', async () => {
        await tool.handler(summaryLevelArgs)

        expect(mockMetadata.searchSummaryLevels).toHaveBeenCalledWith(
          summaryLevelArgs.summary_level,
        )
        expect(
          mockMetadata.searchGeographiesBySummaryLevel,
        ).toHaveBeenCalledWith(summaryLevelArgs.geography_name, '160')
      })
    })
  })

  describe('Response Handling', () => {
    describe('when the summary_levels search returns no summary_levels', () => {
      it('falls back to searchGeographies', async () => {
        mockMetadata.searchSummaryLevels.mockResolvedValue([])

        await tool.handler(summaryLevelArgs)

        expect(mockMetadata.searchSummaryLevels).toHaveBeenCalled()
        expect(mockMetadata.searchGeographies).toHaveBeenCalledWith(
          summaryLevelArgs.geography_name,
        )
      })
    })

    describe('when there are geography results', () => {
      it('returns the found geographies', async () => {
        mockGeographies = [
          {
            id: 1,
            name: 'Los Angeles',
            summary_level_name: 'Place',
            latitude: 34.0522,
            longitude: -118.2437,
            for_param: 'place:44000',
            in_param: 'state:06',
            weighted_score: 0.3,
          },
          {
            id: 2,
            name: 'Los Angeles County',
            summary_level_name: 'County',
            latitude: 34.0522,
            longitude: -118.2437,
            for_param: 'county:037',
            in_param: 'state:06',
            weighted_score: 0.4,
          },
        ]

        mockMetadata.searchGeographies.mockResolvedValue(mockGeographies)

        const result = await tool.handler({ geography_name: 'Los Angeles' })

        expect(result.content).toHaveLength(1)
        expect(result.content[0].type).toBe('text')
        expect(result.content[0].text).toContain(
          'Found 2 Matching Geographies:',
        )
        expect(result.content[0].text).toContain('Los Angeles')
        expect(result.content[0].text).toContain('Los Angeles County')
      })
    })

    describe('when there are no geography results', () => {
      it('returns a message indicating no results', async () => {
        mockMetadata.searchGeographies.mockResolvedValue([])

        const result = await tool.handler({
          geography_name: 'NonexistentPlace',
        })

        expect(result.content).toHaveLength(1)
        expect(result.content[0].type).toBe('text')
        expect(result.content[0].text).toContain(
          'No geographies found matching "NonexistentPlace".',
        )
      })

      it('includes summary level context when specified', async () => {
        mockMetadata.searchSummaryLevels.mockResolvedValue([
          { code: '050', name: 'County' },
        ])
        mockMetadata.searchGeographiesBySummaryLevel.mockResolvedValue([])

        const result = await tool.handler({
          geography_name: 'NonexistentPlace',
          summary_level: 'County',
        })

        expect(result.content[0].text).toContain(
          'No geographies found matching "NonexistentPlace".',
        )
      })
    })
  })
})
