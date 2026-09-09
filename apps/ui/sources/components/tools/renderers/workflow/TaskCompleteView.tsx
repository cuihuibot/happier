import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from '../core/_registry';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { resolveTaskCompleteSummary } from '../../normalization/normalize/taskCompleteSummary';

export const TaskCompleteView = React.memo<ToolViewProps>(({ tool, detailLevel }) => {
    if (detailLevel === 'title') return null;
    const summary = resolveTaskCompleteSummary(tool);
    if (!summary) return null;

    return (
        <ToolSectionView>
            <View style={styles.container}>
                <MarkdownView markdown={summary} agentTexMath />
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.surface.inset,
    },
}));
